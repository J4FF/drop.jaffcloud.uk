const root = document.querySelector('#share-root');
const token = decodeURIComponent(location.pathname.split('/')[2] || '');

loadShare();

async function loadShare() {
  if (!token) {
    renderError('Link not found.');
    return;
  }

  const response = await fetch(`/s/${encodeURIComponent(token)}/info`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    renderError(errorText(data.error));
    return;
  }

  if (data.passwordRequired && !data.authorized) {
    renderPassword(data);
    return;
  }

  renderShare(data);
}

function renderPassword(data) {
  root.innerHTML = `
    <p class="eyebrow">Protected link</p>
    <h1 class="share-title">${escapeHtml(data.name || 'Shared file')}</h1>
    <p class="muted">${formatBytes(data.size || 0)}</p>
    <form id="password-form" class="field">
      <span>Password</span>
      <input name="password" type="password" autocomplete="current-password" required autofocus>
      <button class="primary" type="submit">Unlock</button>
      <p id="password-error" class="error" role="alert"></p>
    </form>
  `;
  root.querySelector('#password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = new FormData(event.target).get('password');
    const response = await fetch(`/s/${encodeURIComponent(token)}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    if (!response.ok) {
      root.querySelector('#password-error').textContent = 'Invalid password.';
      return;
    }
    await loadShare();
  });
}

function renderShare(data) {
  const raw = `/s/${encodeURIComponent(token)}/raw`;
  const download = `/s/${encodeURIComponent(token)}/download`;
  const direct = `/d/${encodeURIComponent(token)}`;
  root.innerHTML = `
    <div class="share-main">
      <div>
        <p class="eyebrow">Shared file</p>
        <h1 class="share-title">${escapeHtml(data.name)}</h1>
        <p class="muted">${formatBytes(data.size)} · ${escapeHtml(data.mime || 'file')}</p>
      </div>
      ${previewMarkup(data, raw)}
      <div class="public-actions">
        <a href="${download}">Download</a>
        <a href="${direct}">Direct link</a>
      </div>
      <div class="details">
        <div class="detail-row"><span>Expires</span><span>${data.expiresAt ? formatDate(data.expiresAt) : 'Never'}</span></div>
        <div class="detail-row"><span>Downloads</span><span>${data.maxDownloads ? `${data.downloadCount}/${data.maxDownloads}` : data.downloadCount}</span></div>
      </div>
    </div>
  `;
  hydrateCodePreview(root);
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

async function hydrateCodePreview(rootElement) {
  const code = rootElement.querySelector('code[data-code-src]');
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

function renderError(message) {
  root.innerHTML = `
    <p class="eyebrow">JaffDrop</p>
    <h1>Unavailable</h1>
    <p class="error">${escapeHtml(message)}</p>
  `;
}

function errorText(code) {
  const messages = {
    share_not_found: 'Link not found.',
    file_not_found: 'File not found.',
    share_expired: 'This link has expired.',
    download_limit_reached: 'The download limit has been reached.',
    password_required: 'Password required.'
  };
  return messages[code] || 'The file is unavailable.';
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
