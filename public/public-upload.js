const dropZone = document.querySelector('#public-drop-zone');
const fileInput = document.querySelector('#public-file-input');
const folderInput = document.querySelector('#public-folder-input');
const uploadList = document.querySelector('#public-uploads');
const results = document.querySelector('#public-results');
const uploadError = document.querySelector('#public-upload-error');

const LARGE_UPLOAD_CHUNK_SIZE = 16 * 1024 * 1024;
const CHUNK_UPLOAD_CONCURRENCY = 1;
const state = {
  uploads: new Map(),
  results: [],
  uploadBaseUrl: ''
};

const configReady = loadConfig();
bindEvents();

function bindEvents() {
  document.querySelector('#public-choose-files').addEventListener('click', () => {
    fileInput.value = '';
    fileInput.click();
  });
  document.querySelector('#public-choose-folder').addEventListener('click', () => {
    folderInput.value = '';
    folderInput.click();
  });
  fileInput.addEventListener('change', () => uploadFiles(fileInput.files));
  folderInput.addEventListener('change', () => uploadFiles(folderInput.files));

  for (const name of ['dragenter', 'dragover']) {
    dropZone.addEventListener(name, (event) => {
      event.preventDefault();
      dropZone.classList.add('dragging');
    });
  }
  for (const name of ['dragleave', 'drop']) {
    dropZone.addEventListener(name, () => dropZone.classList.remove('dragging'));
  }
  dropZone.addEventListener('drop', async (event) => {
    event.preventDefault();
    uploadFiles(await droppedFiles(event.dataTransfer));
  });

  results.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-copy]');
    if (!button) return;
    const label = button.dataset.label || button.textContent;
    button.dataset.label = label;
    await copyText(button.dataset.copy);
    button.textContent = 'Copied';
    setTimeout(() => {
      button.textContent = label;
    }, 1200);
  });
}

async function uploadFiles(source) {
  await configReady;
  uploadError.textContent = '';
  const entries = normalizeUploadSource(source);
  if (!entries.length) {
    uploadError.textContent = 'No files found in this drop.';
    return;
  }

  uploadList.hidden = false;
  const queue = entries.map((entry) => {
    const queued = {
      id: createClientId(),
      file: entry.file,
      name: entry.name,
      loaded: 0,
      total: entry.file.size,
      status: 'Queued'
    };
    state.uploads.set(queued.id, queued);
    return queued;
  });
  renderUploads();

  let active = 0;
  const fileConcurrency = 1;
  let failed = 0;
  await new Promise((resolve) => {
    const next = () => {
      if (!queue.length && active === 0) {
        resolve();
        return;
      }
      while (active < fileConcurrency && queue.length) {
        const entry = queue.shift();
        active += 1;
        uploadOne(entry.file, entry.name, entry.id)
          .catch((error) => {
            failed += 1;
            uploadError.textContent = error.message || 'Upload failed.';
          })
          .finally(() => {
            active -= 1;
            next();
          });
      }
    };
    next();
  });

  fileInput.value = '';
  folderInput.value = '';
  if (failed > 0) {
    uploadError.textContent = `${failed} upload${failed === 1 ? '' : 's'} failed.`;
  }
}

async function uploadOne(file, name, uploadId) {
  const upload = state.uploads.get(uploadId);
  upload.status = 'Preparing';
  renderUploads();

  let remoteUploadId = null;
  try {
    const session = await requestJson(uploadUrl('/api/public/uploads'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        size: file.size,
        mime: file.type || 'application/octet-stream',
        chunkSize: LARGE_UPLOAD_CHUNK_SIZE
      })
    });
    remoteUploadId = session.uploadId;
    upload.status = 'Uploading';
    renderUploads();

    await uploadChunks(file, upload, session);

    upload.status = 'Finalizing';
    renderUploads();
    const completed = await requestJson(uploadUrl(`/api/public/uploads/${encodeURIComponent(remoteUploadId)}/complete`), { method: 'POST' });
    upload.loaded = upload.total;
    upload.status = 'Done';
    renderUploads();
    state.results.unshift(completed);
    renderResults();
  } catch (error) {
    upload.status = 'Failed';
    upload.error = error.message || 'Upload failed.';
    renderUploads();
    if (remoteUploadId) {
      setTimeout(() => {
        fetch(uploadUrl(`/api/public/uploads/${encodeURIComponent(remoteUploadId)}`), {
          method: 'DELETE',
          credentials: 'include'
        }).catch(() => {});
      }, 10 * 60 * 1000);
    }
    throw error;
  }
}

async function uploadChunks(file, upload, session) {
  const totalChunks = session.totalChunks;
  const received = new Set(session.received || []);
  let completedBytes = 0;
  for (const index of received) {
    completedBytes += chunkSizeFor(file.size, session.chunkSize, index, totalChunks);
  }
  const queue = [];
  for (let index = 0; index < totalChunks; index += 1) {
    if (!received.has(index)) queue.push(index);
  }

  const inFlight = new Map();
  upload.loaded = completedBytes;
  renderUploads();

  let active = 0;
  let firstError = null;
  await new Promise((resolve, reject) => {
    const next = () => {
      if (!queue.length && active === 0) {
        if (firstError) reject(firstError);
        else resolve();
        return;
      }
      while (!firstError && active < CHUNK_UPLOAD_CONCURRENCY && queue.length) {
        const index = queue.shift();
        active += 1;
        sendChunk(file, session, index, inFlight, (loaded) => {
          inFlight.set(index, loaded);
          upload.loaded = completedBytes + Array.from(inFlight.values()).reduce((sum, value) => sum + value, 0);
          renderUploads();
        })
          .then((bytes) => {
            completedBytes += bytes;
            inFlight.delete(index);
            upload.loaded = completedBytes + Array.from(inFlight.values()).reduce((sum, value) => sum + value, 0);
            renderUploads();
          })
          .catch((error) => {
            firstError = error;
          })
          .finally(() => {
            active -= 1;
            next();
          });
      }
    };
    next();
  });
}

function sendChunk(file, session, index, inFlight, onProgress) {
  const start = index * session.chunkSize;
  const end = Math.min(start + session.chunkSize, file.size);
  const chunk = file.slice(start, end);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', uploadUrl(`/api/public/uploads/${encodeURIComponent(session.uploadId)}/chunks/${index}`));
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      onProgress(event.loaded);
    };
    xhr.onload = () => {
      inFlight.delete(index);
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(chunk.size);
        return;
      }
      reject(new Error(uploadErrorText(xhr.status, xhr.responseText)));
    };
    xhr.onerror = () => {
      inFlight.delete(index);
      reject(new Error('Network error while uploading.'));
    };
    xhr.onabort = () => {
      inFlight.delete(index);
      reject(new Error('Upload cancelled.'));
    };
    xhr.send(chunk);
  });
}

async function requestJson(url, options) {
  const response = await fetch(url, { credentials: 'include', ...(options || {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(uploadErrorText(response.status, JSON.stringify(data)));
  }
  return data;
}

async function loadConfig() {
  try {
    const response = await fetch('/api/config');
    if (!response.ok) return;
    const config = await response.json().catch(() => ({}));
    setUploadBaseUrl(config.uploadBaseUrl);
  } catch {
    // Keep same-origin uploads when config cannot be loaded.
  }
}

function setUploadBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    state.uploadBaseUrl = '';
    return;
  }
  try {
    const url = new URL(value);
    state.uploadBaseUrl = url.origin === window.location.origin ? '' : url.origin;
  } catch {
    state.uploadBaseUrl = '';
  }
}

function uploadUrl(path) {
  return `${state.uploadBaseUrl}${path}`;
}

function renderUploads() {
  const uploads = Array.from(state.uploads.values()).slice(-12);
  uploadList.hidden = uploads.length === 0;
  uploadList.innerHTML = uploads.map((upload) => {
    const value = upload.total ? Math.round((upload.loaded / upload.total) * 100) : 0;
    return `
      <div class="upload-item">
        <div>
          <strong>${escapeHtml(upload.name)}</strong>
          <span>${escapeHtml(upload.status)} · ${formatBytes(upload.loaded)} / ${formatBytes(upload.total)}${upload.error ? ` · ${escapeHtml(upload.error)}` : ''}</span>
        </div>
        <progress value="${value}" max="100"></progress>
      </div>
    `;
  }).join('');
}

function renderResults() {
  results.hidden = state.results.length === 0;
  results.innerHTML = state.results.map((result) => {
    const shareUrl = new URL(result.shareUrl, location.origin).href;
    const directUrl = new URL(result.directUrl, location.origin).href;
    return `
      <article class="result-item">
        <div>
          <h2>${escapeHtml(result.file.name)}</h2>
          <p class="muted">${formatBytes(result.file.size)} · expires ${formatDate(result.expiresAt)}</p>
        </div>
        <div class="copy-field">
          <input readonly value="${escapeHtml(shareUrl)}" aria-label="Share link">
          <button class="secondary" type="button" data-copy="${escapeHtml(shareUrl)}">Copy</button>
        </div>
        <div class="copy-field">
          <input readonly value="${escapeHtml(directUrl)}" aria-label="Direct download link">
          <button class="secondary" type="button" data-copy="${escapeHtml(directUrl)}">Copy direct link</button>
        </div>
        <div class="public-actions">
          <a href="${escapeHtml(shareUrl)}">Open viewer</a>
          <a href="${escapeHtml(directUrl)}">Download file</a>
        </div>
      </article>
    `;
  }).join('');
}

function chunkSizeFor(totalSize, chunkSize, index, totalChunks) {
  if (totalSize === 0) return 0;
  if (index === totalChunks - 1) return totalSize - (chunkSize * index);
  return chunkSize;
}

function normalizeUploadSource(source) {
  if (!source) return [];
  if (Array.isArray(source) && source.every((entry) => entry?.file instanceof File)) {
    return source.map((entry) => ({
      file: entry.file,
      name: cleanUploadName(entry.name || entry.file.webkitRelativePath || entry.file.name)
    })).filter((entry) => entry.file && entry.name);
  }
  return Array.from(source)
    .filter((file) => file instanceof File)
    .map((file) => ({
      file,
      name: cleanUploadName(file.webkitRelativePath || file.name)
    }))
    .filter((entry) => entry.name);
}

async function droppedFiles(dataTransfer) {
  const items = Array.from(dataTransfer?.items || []);
  const entries = items
    .map((item) => typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null)
    .filter(Boolean);

  if (!entries.length) return normalizeUploadSource(dataTransfer?.files);

  const resolved = [];
  for (const entry of entries) {
    resolved.push(...await readDroppedEntry(entry, ''));
  }
  return resolved.length ? resolved : normalizeUploadSource(dataTransfer?.files);
}

async function readDroppedEntry(entry, prefix) {
  if (!entry) return [];
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    return [{ file, name: cleanUploadName(`${prefix}${file.name}`) }];
  }
  if (!entry.isDirectory) return [];

  const reader = entry.createReader();
  const children = [];
  for (;;) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    children.push(...batch);
  }

  const files = [];
  const nextPrefix = `${prefix}${entry.name}/`;
  for (const child of children) {
    files.push(...await readDroppedEntry(child, nextPrefix));
  }
  return files;
}

function cleanUploadName(name) {
  const cleaned = String(name || 'upload.bin')
    .replace(/[\0\r\n]/g, '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/')
    .slice(0, 512);
  return cleaned || 'upload.bin';
}

function createClientId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const random = globalThis.crypto?.getRandomValues
    ? Array.from(globalThis.crypto.getRandomValues(new Uint32Array(4))).map((value) => value.toString(16)).join('')
    : `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  return `upload-${Date.now().toString(36)}-${random}`;
}

function uploadErrorText(status, responseText) {
  if (status === 413) return 'Upload chunk is too large for the proxy.';
  try {
    const parsed = JSON.parse(responseText);
    return parsed.error || `Upload failed with HTTP ${status}.`;
  } catch {
    return responseText || `Upload failed with HTTP ${status}.`;
  }
}

async function copyText(text) {
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const input = document.createElement('input');
  input.value = text;
  document.body.append(input);
  input.select();
  document.execCommand('copy');
  input.remove();
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
