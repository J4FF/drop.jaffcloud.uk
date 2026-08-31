const fileRows = document.querySelector('#file-rows');
const empty = document.querySelector('#empty');
const inspector = document.querySelector('#inspector');
const uploadList = document.querySelector('#uploads');
const shareDialog = document.querySelector('#share-dialog');
const shareContent = document.querySelector('#share-content');
const settingsDialog = document.querySelector('#settings-dialog');
const settingsForm = document.querySelector('#settings-form');
const directDownloadEnabled = document.querySelector('#direct-download-enabled');
const directDownloadAddress = document.querySelector('#direct-download-address');
const directDownloadStatus = document.querySelector('#direct-download-status');
const settingsError = document.querySelector('#settings-error');
const searchInput = document.querySelector('#search');
const sortSelect = document.querySelector('#sort');
const dropZone = document.querySelector('#drop-zone');
const fileInput = document.querySelector('#file-input');
const folderInput = document.querySelector('#folder-input');
const uploadError = document.querySelector('#upload-error');
const selectAll = document.querySelector('#select-all');
const selectionBar = document.querySelector('#selection-bar');
const selectedCount = document.querySelector('#selected-count');
const deleteSelectedButton = document.querySelector('#delete-selected');
const clearSelectionButton = document.querySelector('#clear-selection');

const state = {
  files: [],
  selectedId: null,
  uploads: new Map(),
  selectedIds: new Set(),
  uploadBaseUrl: '',
  directDownloadOrigin: ''
};
const LARGE_UPLOAD_CHUNK_SIZE = 16 * 1024 * 1024;
const CHUNK_UPLOAD_CONCURRENCY = 1;

init();

async function init() {
  bindEvents();
  await loadConfig();
  const session = await fetch('/api/session');
  if (session.ok) {
    await loadFiles();
    return;
  }
  showLogin();
}

function bindEvents() {
  document.querySelector('#logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    state.files = [];
    state.selectedId = null;
    showLogin();
  });

  document.querySelector('#refresh').addEventListener('click', loadFiles);
  document.querySelector('#open-settings').addEventListener('click', openSettings);
  document.querySelector('#choose-files').addEventListener('click', () => {
    fileInput.value = '';
    fileInput.click();
  });
  document.querySelector('#choose-folder').addEventListener('click', () => {
    folderInput.value = '';
    folderInput.click();
  });
  fileInput.addEventListener('change', () => uploadFiles(fileInput.files));
  folderInput.addEventListener('change', () => uploadFiles(folderInput.files));
  searchInput.addEventListener('input', renderFiles);
  sortSelect.addEventListener('change', renderFiles);
  selectAll.addEventListener('change', () => toggleVisibleSelection(selectAll.checked));
  deleteSelectedButton.addEventListener('click', deleteSelectedFiles);
  clearSelectionButton.addEventListener('click', clearSelection);
  directDownloadEnabled.addEventListener('change', syncSettingsForm);
  directDownloadAddress.addEventListener('input', syncSettingsForm);
  settingsForm.addEventListener('submit', saveSettings);

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

  fileRows.addEventListener('click', async (event) => {
    const checkbox = event.target.closest('input[data-select]');
    const button = event.target.closest('button[data-action]');
    const row = event.target.closest('tr[data-id]');
    if (!row) return;
    const file = state.files.find((item) => item.id === row.dataset.id);
    if (!file) return;
    if (checkbox) {
      event.stopPropagation();
      setFileSelected(file.id, checkbox.checked);
      return;
    }
    if (button) {
      event.stopPropagation();
      await runAction(button.dataset.action, file);
      return;
    }
    selectFile(file.id);
  });

  shareContent.addEventListener('click', async (event) => {
    const copyButton = event.target.closest('button[data-copy]');
    if (copyButton) {
      await copyText(copyButton.dataset.copy);
      copyButton.textContent = 'Copied';
      setTimeout(() => {
        copyButton.textContent = 'Copy';
      }, 1200);
      return;
    }

    const revokeButton = event.target.closest('button[data-revoke]');
    if (revokeButton) {
      await revokeShare(revokeButton.dataset.revoke);
    }
  });

  shareContent.addEventListener('submit', async (event) => {
    if (event.target.id !== 'share-form') return;
    event.preventDefault();
    const file = currentFile();
    if (!file) return;
    const form = new FormData(event.target);
    const payload = {
      expiresInSeconds: Number(form.get('expiresInSeconds')),
      maxDownloads: Number(form.get('maxDownloads')) || null,
      password: String(form.get('password') || ''),
      note: String(form.get('note') || '')
    };
    await api(`/api/files/${file.id}/shares`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    event.target.reset();
    await loadFiles(false);
    renderShareDialog(currentFile());
    renderInspector(currentFile());
  });
}

function showLogin() {
  window.location.replace('/login');
}

async function api(url, options) {
  const response = await fetch(url, options);
  if (response.status === 401) {
    showLogin();
    throw new Error('Unauthorized');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  return data;
}

async function loadFiles(showLoading = true) {
  if (showLoading) {
    empty.textContent = 'Loading files.';
    empty.hidden = false;
  }
  const data = await api('/api/files');
  state.files = data.files || [];
  pruneSelection();
  updateStats(data.stats || {});
  renderFiles();
  if (state.selectedId && currentFile()) {
    renderInspector(currentFile());
  } else if (state.files.length) {
    selectFile(state.files[0].id);
  } else {
    inspector.innerHTML = '<p class="muted">Select a file.</p>';
  }
}

function renderFiles() {
  const files = filteredFiles();
  empty.hidden = files.length > 0;
  empty.textContent = 'No files match the current filter.';
  fileRows.innerHTML = files.map((file) => {
    const rowClasses = [
      file.id === state.selectedId ? 'selected' : '',
      state.selectedIds.has(file.id) ? 'checked' : ''
    ].filter(Boolean).join(' ');
    return `
    <tr data-id="${escapeHtml(file.id)}" class="${rowClasses}">
      <td class="select-cell">
        <input data-select="${escapeHtml(file.id)}" type="checkbox" ${state.selectedIds.has(file.id) ? 'checked' : ''} aria-label="Select ${escapeHtml(file.name)}">
      </td>
      <td>
        <div class="file-name">
          <strong>${escapeHtml(file.name)}</strong>
          <span class="meta">${escapeHtml(file.sha256.slice(0, 16))}</span>
        </div>
      </td>
      <td>${formatBytes(file.size)}</td>
      <td><span class="pill">${escapeHtml(typeLabel(file))}</span></td>
      <td>${file.shares.length}</td>
      <td>${file.downloads}</td>
      <td>${formatDate(file.createdAt)}</td>
      <td>
        <div class="row-actions">
          <button class="ghost" data-action="share" type="button">Share</button>
          <button class="ghost" data-action="download" type="button">Download</button>
        </div>
      </td>
    </tr>
  `;
  }).join('');
  updateSelectionUi(files);
}

function filteredFiles() {
  const query = searchInput.value.trim().toLowerCase();
  const files = state.files.filter((file) => {
    if (!query) return true;
    return `${file.name} ${file.mime} ${file.sha256}`.toLowerCase().includes(query);
  });
  const sort = sortSelect.value;
  files.sort((a, b) => {
    if (sort === 'name-asc') return a.name.localeCompare(b.name);
    if (sort === 'size-desc') return b.size - a.size;
    if (sort === 'downloads-desc') return b.downloads - a.downloads;
    return b.createdAt.localeCompare(a.createdAt);
  });
  return files;
}

function selectFile(id) {
  state.selectedId = id;
  renderFiles();
  renderInspector(currentFile());
}

function currentFile() {
  return state.files.find((file) => file.id === state.selectedId) || null;
}

function renderInspector(file) {
  if (!file) {
    inspector.innerHTML = '<p class="muted">Select a file.</p>';
    return;
  }

  inspector.innerHTML = `
    <div>
      <p class="eyebrow">${escapeHtml(typeLabel(file))}</p>
      <h2>${escapeHtml(file.name)}</h2>
    </div>
    ${previewMarkup(file, `/api/files/${encodeURIComponent(file.id)}/raw`)}
    <div class="button-row">
      <button class="primary" type="button" data-inspector="share">Share</button>
      <button class="secondary" type="button" data-inspector="download">Download</button>
      <button class="ghost" type="button" data-inspector="rename">Rename</button>
      <button class="danger" type="button" data-inspector="delete">Delete</button>
    </div>
    <div class="details">
      <div class="detail-row"><span>Size</span><strong>${formatBytes(file.size)}</strong></div>
      <div class="detail-row"><span>MIME</span><span>${escapeHtml(file.mime)}</span></div>
      <div class="detail-row"><span>Source</span><span>${escapeHtml(file.source === 'public' ? 'public upload' : 'admin')}</span></div>
      <div class="detail-row"><span>Expires</span><span>${file.expiresAt ? formatDate(file.expiresAt) : 'Never'}</span></div>
      <div class="detail-row"><span>SHA-256</span><code>${escapeHtml(file.sha256)}</code></div>
      <div class="detail-row"><span>Uploaded</span><span>${formatDate(file.createdAt)}</span></div>
      <div class="detail-row"><span>Downloads</span><span>${file.downloads}</span></div>
    </div>
    <div class="share-list">
      <h3>Active links</h3>
      ${file.shares.length ? file.shares.slice(0, 4).map((share) => shareSummary(share)).join('') : '<p class="muted">No links.</p>'}
    </div>
  `;

  inspector.querySelector('[data-inspector="share"]').addEventListener('click', () => openShare(file));
  inspector.querySelector('[data-inspector="download"]').addEventListener('click', () => {
    window.location.href = `/api/files/${encodeURIComponent(file.id)}/download`;
  });
  inspector.querySelector('[data-inspector="rename"]').addEventListener('click', () => renameFile(file));
  inspector.querySelector('[data-inspector="delete"]').addEventListener('click', () => deleteFile(file));
  hydrateCodePreview(inspector);
}

function previewMarkup(file, src) {
  if (file.preview === 'code') {
    return `<div class="preview code-preview"><pre><code data-code-src="${src}" data-code-size="${file.size}">Loading...</code></pre></div>`;
  }
  if (file.preview === 'video') {
    return `<div class="preview"><video controls preload="metadata" src="${src}"></video></div>`;
  }
  if (file.preview === 'audio') {
    return `<div class="preview"><audio controls preload="metadata" src="${src}"></audio></div>`;
  }
  if (file.preview === 'image') {
    return `<div class="preview"><img src="${src}" alt=""></div>`;
  }
  if (file.preview === 'pdf' || file.preview === 'text') {
    return `<div class="preview"><iframe src="${src}" title="Preview"></iframe></div>`;
  }
  return '<div class="preview"><p class="muted">No preview available.</p></div>';
}

async function hydrateCodePreview(root) {
  const code = root.querySelector('code[data-code-src]');
  if (!code) return;
  const size = Number(code.dataset.codeSize || 0);
  const limit = 1024 * 1024;
  try {
    const response = await fetch(code.dataset.codeSrc, {
      headers: size > limit ? { Range: `bytes=0-${limit - 1}` } : {}
    });
    if (!response.ok && response.status !== 206) {
      code.textContent = 'Preview unavailable.';
      return;
    }
    const text = await response.text();
    code.innerHTML = highlightCode(size > limit ? `${text}\n\n...` : text);
  } catch {
    code.textContent = 'Preview unavailable.';
  }
}

const CODE_KEYWORDS = new Set([
  'and', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const',
  'continue', 'def', 'default', 'delete', 'do', 'elif', 'else', 'enum', 'export',
  'extends', 'false', 'finally', 'for', 'from', 'func', 'function', 'go', 'if',
  'import', 'in', 'interface', 'let', 'match', 'new', 'nil', 'not', 'null', 'or',
  'package', 'private', 'protected', 'public', 'return', 'self', 'static', 'struct',
  'switch', 'this', 'throw', 'true', 'try', 'type', 'undefined', 'var', 'void',
  'while', 'with', 'yield'
]);

const CODE_LITERALS = new Set(['true', 'false', 'null', 'nil', 'none', 'undefined']);

function highlightCode(source) {
  let html = '';
  let i = 0;
  const push = (className, value) => {
    html += className ? `<span class="${className}">${escapeHtml(value)}</span>` : escapeHtml(value);
  };

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const value = source.slice(i, end === -1 ? source.length : end);
      push('tok-comment', value);
      i += value.length;
      continue;
    }

    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const value = source.slice(i, end === -1 ? source.length : end + 2);
      push('tok-comment', value);
      i += value.length;
      continue;
    }

    if (ch === '#' && (i === 0 || source[i - 1] === '\n')) {
      const end = source.indexOf('\n', i);
      const value = source.slice(i, end === -1 ? source.length : end);
      push('tok-comment', value);
      i += value.length;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === ch) {
          j += 1;
          break;
        }
        j += 1;
      }
      const value = source.slice(i, j);
      push('tok-string', value);
      i = j;
      continue;
    }

    if (/\d/.test(ch)) {
      let j = i + 1;
      while (j < source.length && /[0-9a-fA-FxXoObB._]/.test(source[j])) j += 1;
      push('tok-number', source.slice(i, j));
      i = j;
      continue;
    }

    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < source.length && /[A-Za-z0-9_$-]/.test(source[j])) j += 1;
      const word = source.slice(i, j);
      const lower = word.toLowerCase();
      const after = source.slice(j).match(/^\s*\(/);
      if (CODE_LITERALS.has(lower)) push('tok-literal', word);
      else if (CODE_KEYWORDS.has(lower)) push('tok-keyword', word);
      else if (after) push('tok-function', word);
      else push('', word);
      i = j;
      continue;
    }

    if (/[{}()[\].,;:+\-*%=!<>|&?~^]/.test(ch)) {
      push('tok-operator', ch);
      i += 1;
      continue;
    }

    push('', ch);
    i += 1;
  }

  return html;
}

async function runAction(action, file) {
  if (action === 'share') {
    openShare(file);
  }
  if (action === 'download') {
    window.location.href = `/api/files/${encodeURIComponent(file.id)}/download`;
  }
}

async function renameFile(file) {
  const name = prompt('New name', file.name);
  if (!name || name === file.name) return;
  await api(`/api/files/${file.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  await loadFiles(false);
}

async function deleteFile(file) {
  if (!confirm(`Delete ${file.name}?`)) return;
  await api(`/api/files/${file.id}`, { method: 'DELETE' });
  state.selectedId = null;
  state.selectedIds.delete(file.id);
  await loadFiles(false);
}

async function deleteSelectedFiles() {
  const files = selectedFiles();
  if (!files.length) return;
  if (!confirm(`Delete ${files.length} selected file${files.length === 1 ? '' : 's'}?`)) return;

  deleteSelectedButton.disabled = true;
  deleteSelectedButton.textContent = 'Deleting';
  try {
    for (const file of files) {
      await api(`/api/files/${file.id}`, { method: 'DELETE' });
    }
    state.selectedIds.clear();
    if (state.selectedId && !state.files.some((file) => file.id === state.selectedId && !files.some((selected) => selected.id === file.id))) {
      state.selectedId = null;
    }
    await loadFiles(false);
  } finally {
    deleteSelectedButton.disabled = false;
    deleteSelectedButton.textContent = 'Delete selected';
  }
}

function selectedFiles() {
  return state.files.filter((file) => state.selectedIds.has(file.id));
}

function setFileSelected(id, selected) {
  if (selected) {
    state.selectedIds.add(id);
  } else {
    state.selectedIds.delete(id);
  }
  renderFiles();
}

function toggleVisibleSelection(selected) {
  for (const file of filteredFiles()) {
    if (selected) {
      state.selectedIds.add(file.id);
    } else {
      state.selectedIds.delete(file.id);
    }
  }
  renderFiles();
}

function clearSelection() {
  state.selectedIds.clear();
  renderFiles();
}

function pruneSelection() {
  const existing = new Set(state.files.map((file) => file.id));
  for (const id of Array.from(state.selectedIds)) {
    if (!existing.has(id)) {
      state.selectedIds.delete(id);
    }
  }
}

function updateSelectionUi(visibleFiles = filteredFiles()) {
  const count = state.selectedIds.size;
  selectionBar.hidden = count === 0;
  selectedCount.textContent = `${count} selected`;
  const visibleSelected = visibleFiles.filter((file) => state.selectedIds.has(file.id)).length;
  selectAll.checked = visibleFiles.length > 0 && visibleSelected === visibleFiles.length;
  selectAll.indeterminate = visibleSelected > 0 && visibleSelected < visibleFiles.length;
}

function openShare(file) {
  state.selectedId = file.id;
  renderShareDialog(file);
  shareDialog.showModal();
}

function renderShareDialog(file) {
  if (!file) return;
  shareContent.innerHTML = `
    <div class="share-main">
      <div>
        <p class="muted">${escapeHtml(file.name)}</p>
      </div>
      <form id="share-form" class="share-form">
        <label class="field">
          <span>Expires</span>
          <select name="expiresInSeconds">
            <option value="0">Never</option>
            <option value="3600">1 hour</option>
            <option value="86400">24 hours</option>
            <option value="604800">7 days</option>
            <option value="2592000">30 days</option>
          </select>
        </label>
        <label class="field">
          <span>Download limit</span>
          <input name="maxDownloads" type="number" min="1" placeholder="Unlimited">
        </label>
        <label class="field">
          <span>Password</span>
          <input name="password" type="password" autocomplete="new-password" placeholder="Optional">
        </label>
        <label class="field">
          <span>Note</span>
          <input name="note" maxlength="200" placeholder="Optional">
        </label>
        <div class="share-actions full">
          <button class="primary" type="submit">Create link</button>
        </div>
      </form>
      <div class="share-list">
        ${file.shares.length ? file.shares.map(fullShareItem).join('') : '<p class="muted">No links yet.</p>'}
      </div>
    </div>
  `;
}

function fullShareItem(share) {
  const page = `${location.origin}/s/${share.token}`;
  const direct = new URL(share.directUrl || `/d/${encodeURIComponent(share.token)}`, location.origin).href;
  return `
    <div class="share-item">
      ${shareSummary(share)}
      <div class="copy-field">
        <input readonly value="${escapeHtml(page)}" aria-label="Share page">
        <button class="secondary" type="button" data-copy="${escapeHtml(page)}">Copy</button>
      </div>
      <div class="copy-field">
        <input readonly value="${escapeHtml(direct)}" aria-label="Direct download">
        <button class="secondary" type="button" data-copy="${escapeHtml(direct)}">Copy</button>
      </div>
      <div>
        <button class="danger" type="button" data-revoke="${escapeHtml(share.token)}">Revoke</button>
      </div>
    </div>
  `;
}

function shareSummary(share) {
  const expiry = share.expiresAt ? `expires ${formatDate(share.expiresAt)}` : 'no expiry';
  const limit = share.maxDownloads ? `${share.downloadCount}/${share.maxDownloads} downloads` : `${share.downloadCount} downloads`;
  const lock = share.passwordProtected ? 'password' : 'open';
  return `<p class="meta">${escapeHtml(expiry)} · ${escapeHtml(limit)} · ${escapeHtml(lock)}</p>`;
}

async function revokeShare(token) {
  if (!confirm('Revoke this link?')) return;
  await api(`/api/shares/${token}`, { method: 'DELETE' });
  await loadFiles(false);
  renderShareDialog(currentFile());
  renderInspector(currentFile());
}

async function uploadFiles(source) {
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
    state.uploads.set(queued.id, {
      id: queued.id,
      name: queued.name,
      loaded: queued.loaded,
      total: queued.total,
      status: queued.status
    });
    return queued;
  });
  renderUploads();

  let active = 0;
  const concurrency = 1;
  let failed = 0;
  await new Promise((resolve) => {
    const next = () => {
      if (!queue.length && active === 0) {
        resolve();
        return;
      }
      while (active < concurrency && queue.length) {
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
  await loadFiles(false);
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
    const session = await requestJson(uploadUrl('/api/uploads'), {
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
    upload.loaded = 0;
    upload.total = file.size;
    renderUploads();

    await uploadChunks(file, upload, session);

    upload.status = 'Finalizing';
    renderUploads();
    await requestJson(uploadUrl(`/api/uploads/${encodeURIComponent(remoteUploadId)}/complete`), { method: 'POST' });
    upload.loaded = upload.total;
    upload.status = 'Done';
    renderUploads();
  } catch (error) {
    upload.status = 'Failed';
    upload.error = error.message || 'Upload failed.';
    renderUploads();
    if (remoteUploadId) {
      setTimeout(() => {
        fetch(uploadUrl(`/api/uploads/${encodeURIComponent(remoteUploadId)}`), {
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
    if (!received.has(index)) {
      queue.push(index);
    }
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
    xhr.open('POST', uploadUrl(`/api/uploads/${encodeURIComponent(session.uploadId)}/chunks/${index}`));
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
  if (response.status === 401) {
    showLogin();
    throw new Error('Session expired. Sign in again.');
  }
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
    state.directDownloadOrigin = typeof config.directDownloadOrigin === 'string'
      ? config.directDownloadOrigin
      : '';
  } catch {
    // Keep same-origin uploads when config cannot be loaded.
  }
}

async function openSettings() {
  settingsError.textContent = '';
  const settings = await api('/api/settings');
  directDownloadEnabled.checked = settings.directDownloadsEnabled === true;
  directDownloadAddress.value = settings.directDownloadAddress || '';
  renderSettingsRoute(settings.activeDirectDownloadOrigin || '');
  syncSettingsForm();
  settingsDialog.showModal();
}

function syncSettingsForm() {
  directDownloadAddress.disabled = !directDownloadEnabled.checked;
  renderSettingsRoute(directDownloadEnabled.checked ? directDownloadAddress.value.trim() : '');
}

function renderSettingsRoute(origin) {
  directDownloadStatus.textContent = origin || 'Tunnel';
}

async function saveSettings(event) {
  event.preventDefault();
  settingsError.textContent = '';
  try {
    const settings = await api('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        directDownloadsEnabled: directDownloadEnabled.checked,
        directDownloadAddress: directDownloadAddress.value.trim()
      })
    });
    state.directDownloadOrigin = settings.activeDirectDownloadOrigin || '';
    directDownloadAddress.value = settings.directDownloadAddress || '';
    renderSettingsRoute(state.directDownloadOrigin);
    await loadFiles(false);
    settingsDialog.close();
  } catch (error) {
    settingsError.textContent = error.message === 'direct_download_address_required'
      ? 'Enter a valid IP address, host, or HTTP(S) URL.'
      : error.message;
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

function chunkSizeFor(totalSize, chunkSize, index, totalChunks) {
  if (totalSize === 0) return 0;
  if (index === totalChunks - 1) {
    return totalSize - (chunkSize * index);
  }
  return chunkSize;
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

function updateStats(stats) {
  document.querySelector('#stat-files').textContent = stats.fileCount || 0;
  document.querySelector('#stat-stored').textContent = formatBytes(stats.storedBytes || 0);
  document.querySelector('#stat-shares').textContent = stats.activeShareCount || 0;
  document.querySelector('#stat-downloads').textContent = stats.downloads || 0;
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

function typeLabel(file) {
  if (file.preview) return file.preview;
  return file.mime?.split('/')[1] || 'file';
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

  if (!entries.length) {
    return normalizeUploadSource(dataTransfer?.files);
  }

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
  if (!entry.isDirectory) {
    return [];
  }

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
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  const random = globalThis.crypto?.getRandomValues
    ? Array.from(globalThis.crypto.getRandomValues(new Uint32Array(4))).map((value) => value.toString(16)).join('')
    : `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  return `upload-${Date.now().toString(36)}-${random}`;
}

function uploadErrorText(status, responseText) {
  if (status === 401) return 'Session expired. Sign in again.';
  if (status === 413) return 'Upload chunk is too large for the proxy.';
  try {
    const parsed = JSON.parse(responseText);
    return parsed.error || `Upload failed with HTTP ${status}.`;
  } catch {
    return responseText || `Upload failed with HTTP ${status}.`;
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
