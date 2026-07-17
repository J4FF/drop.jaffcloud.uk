import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import { isIP } from 'node:net';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DROP_DATA_DIR || path.join(APP_DIR, 'data');
const FILE_DIR = process.env.DROP_FILE_DIR || path.join(APP_DIR, 'storage', 'files');
const UPLOAD_DIR = process.env.DROP_UPLOAD_DIR || path.join(APP_DIR, 'storage', 'uploads');
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PASSWORD_FILE = path.join(DATA_DIR, 'admin-password.txt');
const HOST = process.env.DROP_HOST || '0.0.0.0';
const PORT = Number.parseInt(process.env.DROP_PORT || process.env.PORT || '8787', 10);
const JSON_LIMIT = 1024 * 1024;
const STREAM_HIGH_WATER_MARK = 1024 * 1024;
const MAX_CHUNK_BYTES = 96 * 1024 * 1024;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24;
const UPLOAD_SESSION_TTL_MS = 1000 * 60 * 60 * 48;
const PUBLIC_FILE_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const DIRECT_ACCESS_TTL_MS = 1000 * 60 * 15;
const PBKDF2_ITERATIONS = 210000;
const UPLOAD_BASE_URL = normalizeBaseUrl(process.env.DROP_UPLOAD_BASE_URL || '');
const PUBLIC_ORIGIN = normalizeOrigin(process.env.DROP_PUBLIC_ORIGIN || '');
const COOKIE_DOMAIN = cleanCookieDomain(process.env.DROP_COOKIE_DOMAIN || '');
const CORS_ORIGINS = new Set([
  PUBLIC_ORIGIN,
  ...csvValues(process.env.DROP_CORS_ORIGINS || '')
    .map((origin) => normalizeOrigin(origin))
].filter(Boolean));
const sessions = new Map();
const fileExpiryTimers = new Map();

const GERMAN_WORDS = [
  'ab', 'als', 'am', 'an', 'auf', 'aus', 'bei', 'bis', 'da', 'das', 'dem', 'den', 'der', 'des', 'die', 'du', 'ein', 'er', 'es', 'für', 'im', 'in', 'ist', 'ja', 'man', 'mit', 'nach', 'ob', 'oder', 'so', 'um', 'und', 'uns', 'von', 'vor', 'was', 'wie', 'wir', 'zu', 'arm', 'bad', 'bau', 'box', 'bus', 'ei', 'eis', 'elf', 'fee', 'gas', 'gut', 'hai', 'hof', 'hut', 'ich', 'ihm', 'ihn', 'ihr', 'job', 'kuh', 'kur', 'lob', 'los', 'mai', 'mal', 'mut', 'nah', 'neu', 'nie', 'not', 'nun', 'nur', 'oft', 'ohr', 'ost', 'rad', 'rat', 'roh', 'rot', 'ruf', 'sau', 'see', 'sie', 'tag', 'tal', 'tee', 'tod', 'ton', 'tot', 'tun', 'uhr', 'viel', 'vom', 'war', 'weg', 'wem', 'wen', 'wer', 'wo', 'wut', 'zug'
];

function generateGermanToken() {
  const word1 = GERMAN_WORDS[crypto.randomInt(0, GERMAN_WORDS.length)];
  const word2 = GERMAN_WORDS[crypto.randomInt(0, GERMAN_WORDS.length)];
  const word3 = GERMAN_WORDS[crypto.randomInt(0, GERMAN_WORDS.length)];
  return `${word1}-${word2}-${word3}`;
}

const MIME_TYPES = {
  '.aac': 'audio/aac',
  '.avi': 'video/x-msvideo',
  '.avif': 'image/avif',
  '.bin': 'application/octet-stream',
  '.bmp': 'image/bmp',
  '.bash': 'text/x-shellscript; charset=utf-8',
  '.c': 'text/x-c; charset=utf-8',
  '.cpp': 'text/x-c++; charset=utf-8',
  '.cs': 'text/x-csharp; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.env': 'text/plain; charset=utf-8',
  '.flac': 'audio/flac',
  '.gif': 'image/gif',
  '.go': 'text/x-go; charset=utf-8',
  '.h': 'text/x-c; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.java': 'text/x-java-source; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.jsx': 'text/jsx; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.kt': 'text/x-kotlin; charset=utf-8',
  '.kts': 'text/x-kotlin; charset=utf-8',
  '.m4a': 'audio/mp4',
  '.md': 'text/markdown; charset=utf-8',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.ogv': 'video/ogg',
  '.pdf': 'application/pdf',
  '.php': 'text/x-php; charset=utf-8',
  '.png': 'image/png',
  '.py': 'text/x-python; charset=utf-8',
  '.rb': 'text/x-ruby; charset=utf-8',
  '.rs': 'text/x-rust; charset=utf-8',
  '.sh': 'text/x-shellscript; charset=utf-8',
  '.sql': 'application/sql; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.swift': 'text/x-swift; charset=utf-8',
  '.toml': 'application/toml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ts': 'text/typescript; charset=utf-8',
  '.tsx': 'text/tsx; charset=utf-8',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.xml': 'application/xml; charset=utf-8',
  '.yaml': 'application/yaml; charset=utf-8',
  '.yml': 'application/yaml; charset=utf-8',
  '.zip': 'application/zip'
};

let db;
let saveChain = Promise.resolve();

await boot();

async function boot() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(FILE_DIR, { recursive: true });
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  db = await loadDb();
  await purgeExpiredFiles();
  await purgeExpiredUploads();
  scheduleFileExpiryTimers();
  setInterval(() => purgeExpiredFiles().catch(console.error), 1000 * 60 * 30).unref();
  setInterval(() => purgeExpiredUploads().catch(console.error), 1000 * 60 * 30).unref();

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (isConnectionAbort(error)) {
        return;
      }
      console.error(error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'internal_error' });
      } else {
        res.destroy(error);
      }
    });
  });

  server.headersTimeout = 1000 * 65;
  server.requestTimeout = 0;
  server.listen(PORT, HOST, () => {
    console.log(`JaffDrop listening on http://${HOST}:${PORT}`);
  });
}

async function loadDb() {
  try {
    const parsed = JSON.parse(await fsp.readFile(DB_FILE, 'utf8'));
    parsed.files ||= {};
    parsed.shares ||= {};
    parsed.config ||= {};
    parsed.stats ||= {};
    parsed.config.sessionSecret ||= crypto.randomBytes(32).toString('base64url');
    parsed.config.directDownloadOrigin = normalizeDirectDownloadAddress(parsed.config.directDownloadOrigin);
    parsed.config.directDownloadsEnabled = parsed.config.directDownloadsEnabled === true
      && Boolean(parsed.config.directDownloadOrigin);
    return parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  const generatedPassword = process.env.DROP_ADMIN_PASSWORD || crypto.randomBytes(18).toString('base64url');
  const nextDb = {
    version: 1,
    createdAt: new Date().toISOString(),
    config: {
      adminPassword: hashPassword(generatedPassword),
      sessionSecret: crypto.randomBytes(32).toString('base64url'),
      directDownloadsEnabled: false,
      directDownloadOrigin: ''
    },
    files: {},
    shares: {},
    stats: {
      totalUploads: 0,
      totalBytesUploaded: 0
    }
  };

  if (!process.env.DROP_ADMIN_PASSWORD) {
    await fsp.writeFile(
      PASSWORD_FILE,
      `${generatedPassword}\n`,
      { mode: 0o600 }
    );
  }

  await atomicWriteJson(DB_FILE, nextDb);
  return nextDb;
}

function saveDb() {
  const snapshot = JSON.stringify(db, null, 2);
  saveChain = saveChain.then(async () => {
    const tmp = `${DB_FILE}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, snapshot);
    await fsp.rename(tmp, DB_FILE);
  });
  return saveChain;
}

async function atomicWriteJson(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2));
  await fsp.rename(tmp, file);
}

async function handle(req, res) {
  const requestUrl = safeUrl(req);
  if (!requestUrl) {
    return sendJson(res, 400, { error: 'bad_url' });
  }

  const pathname = requestUrl.pathname;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  const corsApplied = applyCors(req, res);

  if (req.method === 'OPTIONS' && pathname.startsWith('/api/')) {
    if (!corsApplied) {
      return sendJson(res, 403, { error: 'cors_origin_denied' });
    }
    return sendNoContent(res, 204);
  }

  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      service: 'jaffdrop',
      files: Object.keys(db.files).length,
      shares: Object.keys(db.shares).length
    });
  }

  if (req.method === 'GET' && pathname === '/api/config') {
    return sendJson(res, 200, {
      uploadBaseUrl: UPLOAD_BASE_URL,
      directDownloadOrigin: activeDirectDownloadOrigin()
    });
  }

  if (req.method === 'GET' && pathname === '/') {
    return redirect(res, '/upload');
  }

  if (req.method === 'GET' && pathname === '/upload') {
    return servePublicFile(req, res, 'public-upload.html', false);
  }

  if (req.method === 'GET' && pathname === '/login') {
    return servePublicFile(req, res, 'login.html', false);
  }

  if (req.method === 'GET' && pathname === '/admin') {
    if (!isAdmin(req)) {
      return servePublicFile(req, res, 'login.html', false);
    }
    return servePublicFile(req, res, 'admin.html', false);
  }

  if (req.method === 'GET' && pathname.startsWith('/assets/')) {
    return servePublicFile(req, res, pathname.slice('/assets/'.length), true);
  }

  if (pathname === '/api/login' && req.method === 'POST') {
    return login(req, res);
  }

  if (pathname === '/api/logout' && req.method === 'POST') {
    return logout(req, res);
  }

  if (pathname === '/api/session' && req.method === 'GET') {
    const admin = isAdmin(req);
    return sendJson(res, admin ? 200 : 401, admin ? { ok: true, stats: statsView() } : { error: 'unauthorized' });
  }

  if (pathname.startsWith('/api/public/')) {
    return handlePublicApi(req, res, requestUrl);
  }

  if (pathname.startsWith('/api/')) {
    if (!isAdmin(req)) {
      return sendJson(res, 401, { error: 'unauthorized' });
    }
    return handleAdminApi(req, res, requestUrl);
  }

  if (pathname.startsWith('/s/')) {
    return handleShareRoute(req, res, requestUrl);
  }

  if (pathname.startsWith('/d/')) {
    return handleDirectDownload(req, res, requestUrl);
  }

  return sendJson(res, 404, { error: 'not_found' });
}

async function handlePublicApi(req, res, requestUrl) {
  const parts = splitPath(requestUrl.pathname);
  if (parts[2] === 'uploads') {
    return handleUploadsApi(req, res, requestUrl, ['api', ...parts.slice(2)], { publicUpload: true });
  }
  return sendJson(res, 404, { error: 'not_found' });
}

async function login(req, res) {
  const body = await readJson(req);
  if (!body || typeof body.password !== 'string') {
    return sendJson(res, 400, { error: 'password_required' });
  }

  if (!verifyPassword(body.password, db.config.adminPassword)) {
    return sendJson(res, 401, { error: 'invalid_login' });
  }

  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  setCookie(res, 'drop_session', token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000
  });
  return sendJson(res, 200, { ok: true, stats: statsView() });
}

function logout(req, res) {
  const cookie = parseCookies(req).drop_session;
  if (cookie) {
    sessions.delete(cookie);
  }
  clearCookie(res, 'drop_session', '/');
  return sendJson(res, 200, { ok: true });
}

async function handleAdminApi(req, res, requestUrl) {
  const parts = splitPath(requestUrl.pathname);

  if (parts.length === 1 && parts[0] === 'api') {
    return sendJson(res, 404, { error: 'not_found' });
  }

  if (parts[1] === 'stats' && req.method === 'GET') {
    return sendJson(res, 200, statsView());
  }

  if (parts[1] === 'settings' && req.method === 'GET') {
    return sendJson(res, 200, downloadSettingsView());
  }

  if (parts[1] === 'settings' && req.method === 'PATCH') {
    const body = await readJson(req);
    if (!body || typeof body.directDownloadsEnabled !== 'boolean') {
      return sendJson(res, 400, { error: 'direct_download_setting_required' });
    }
    const origin = normalizeDirectDownloadAddress(body.directDownloadAddress);
    if (body.directDownloadsEnabled && !origin) {
      return sendJson(res, 400, { error: 'direct_download_address_required' });
    }
    db.config.directDownloadsEnabled = body.directDownloadsEnabled;
    db.config.directDownloadOrigin = origin;
    await saveDb();
    return sendJson(res, 200, downloadSettingsView());
  }

  if (parts[1] === 'files') {
    return handleFilesApi(req, res, requestUrl, parts);
  }

  if (parts[1] === 'uploads') {
    return handleUploadsApi(req, res, requestUrl, parts, { publicUpload: false });
  }

  if (parts[1] === 'shares' && parts[2] && req.method === 'DELETE') {
    const token = parts[2];
    if (!db.shares[token]) {
      return sendJson(res, 404, { error: 'share_not_found' });
    }
    delete db.shares[token];
    await saveDb();
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'not_found' });
}

async function handleUploadsApi(req, res, requestUrl, parts, options = {}) {
  if (parts.length === 2 && req.method === 'POST') {
    return initChunkedUpload(req, res, options);
  }

  const uploadId = parts[2];
  if (!isSafeUploadId(uploadId)) {
    return sendJson(res, 404, { error: 'upload_not_found' });
  }

  if (parts.length === 3 && req.method === 'GET') {
    const manifest = await readUploadManifest(uploadId);
    if (!manifest) {
      return sendJson(res, 404, { error: 'upload_not_found' });
    }
    if (!canAccessUpload(manifest, options)) {
      return sendJson(res, 404, { error: 'upload_not_found' });
    }
    return sendJson(res, 200, await uploadStatusView(uploadId, manifest));
  }

  if (parts.length === 3 && req.method === 'DELETE') {
    const manifest = await readUploadManifest(uploadId);
    if (manifest && !canAccessUpload(manifest, options)) {
      return sendJson(res, 404, { error: 'upload_not_found' });
    }
    await deleteUploadSession(uploadId, manifest);
    return sendJson(res, 200, { ok: true });
  }

  if (parts[3] === 'chunks' && parts[4] && req.method === 'POST') {
    const index = Number.parseInt(parts[4], 10);
    return uploadChunk(req, res, uploadId, index, options);
  }

  if (parts[3] === 'complete' && req.method === 'POST') {
    return completeChunkedUpload(req, res, uploadId, options);
  }

  return sendJson(res, 404, { error: 'not_found' });
}

async function initChunkedUpload(req, res, options = {}) {
  const body = await readJson(req);
  const name = cleanDisplayName(body?.name);
  const size = Number(body?.size);
  const chunkSize = Number(body?.chunkSize);
  const mime = typeof body?.mime === 'string' ? body.mime.slice(0, 200) : '';

  if (!name) {
    return sendJson(res, 400, { error: 'name_required' });
  }
  if (!Number.isSafeInteger(size) || size < 0) {
    return sendJson(res, 400, { error: 'bad_size' });
  }
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_CHUNK_BYTES) {
    return sendJson(res, 400, { error: 'bad_chunk_size', maxChunkBytes: MAX_CHUNK_BYTES });
  }

  const totalChunks = size === 0 ? 1 : Math.ceil(size / chunkSize);
  const uploadId = crypto.randomUUID();
  const storageId = crypto.randomUUID();
  const storedRel = `${storageId.slice(0, 2)}/${storageId}`;
  const dir = uploadPath(uploadId);
  await fsp.mkdir(chunksPath(uploadId), { recursive: true });
  await ensureUploadAssemblyFile({ storedRel });

  const manifest = {
    uploadId,
    storageId,
    storedRel,
    name,
    size,
    mime: inferMime(name, mime),
    chunkSize,
    totalChunks,
    publicUpload: Boolean(options.publicUpload),
    expiresAt: options.publicUpload ? new Date(Date.now() + PUBLIC_FILE_TTL_MS).toISOString() : null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await writeUploadManifest(uploadId, manifest);
  return sendJson(res, 201, uploadInitView(uploadId, manifest));
}

async function uploadChunk(req, res, uploadId, index, options = {}) {
  const manifest = await readUploadManifest(uploadId);
  if (!manifest) {
    return sendJson(res, 404, { error: 'upload_not_found' });
  }
  if (!canAccessUpload(manifest, options)) {
    return sendJson(res, 404, { error: 'upload_not_found' });
  }
  if (!Number.isSafeInteger(index) || index < 0 || index >= manifest.totalChunks) {
    return sendJson(res, 400, { error: 'bad_chunk_index' });
  }

  const expected = expectedChunkSize(manifest, index);
  const contentLength = Number(req.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > MAX_CHUNK_BYTES) {
    return sendJson(res, 413, { error: 'chunk_too_large', maxChunkBytes: MAX_CHUNK_BYTES });
  }
  if (Number.isFinite(contentLength) && contentLength !== expected) {
    return sendJson(res, 400, { error: 'bad_chunk_size', expected });
  }

  const chunkFile = chunkPath(uploadId, index);
  const tmpFile = `${chunkFile}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > MAX_CHUNK_BYTES) {
        callback(new Error('chunk_too_large'));
        return;
      }
      callback(null, chunk);
    }
  });

  try {
    if (manifest.storedRel) {
      await ensureUploadAssemblyFile(manifest);
      await pipeline(
        req,
        meter,
        fs.createWriteStream(uploadAssemblyPath(manifest), {
          flags: 'r+',
          start: index * manifest.chunkSize,
          highWaterMark: STREAM_HIGH_WATER_MARK
        })
      );
    } else {
      await pipeline(req, meter, fs.createWriteStream(tmpFile, { highWaterMark: STREAM_HIGH_WATER_MARK }));
    }
    if (bytes !== expected) {
      await fsp.rm(tmpFile, { force: true }).catch(() => {});
      return sendJson(res, 400, { error: 'bad_chunk_size', expected, received: bytes });
    }
    if (manifest.storedRel) {
      await atomicWriteJson(tmpFile, { bytes, receivedAt: new Date().toISOString() });
    }
    await fsp.rename(tmpFile, chunkFile);
  } catch (error) {
    await fsp.rm(tmpFile, { force: true }).catch(() => {});
    if (error.message === 'chunk_too_large') {
      return sendJson(res, 413, { error: 'chunk_too_large', maxChunkBytes: MAX_CHUNK_BYTES });
    }
    throw error;
  }

  return sendJson(res, 200, {
    ok: true,
    uploadId,
    index,
    bytes
  });
}

async function completeChunkedUpload(req, res, uploadId, options = {}) {
  const manifest = await readUploadManifest(uploadId);
  if (!manifest) {
    return sendJson(res, 404, { error: 'upload_not_found' });
  }
  if (!canAccessUpload(manifest, options)) {
    return sendJson(res, 404, { error: 'upload_not_found' });
  }

  const received = await receivedChunks(uploadId, manifest);
  if (received.length !== manifest.totalChunks) {
    return sendJson(res, 409, {
      error: 'chunks_missing',
      received,
      totalChunks: manifest.totalChunks
    });
  }

  const id = manifest.storageId || crypto.randomUUID();
  const storedRel = manifest.storedRel || `${id.slice(0, 2)}/${id}`;
  const finalPath = path.join(FILE_DIR, storedRel);
  const tmpPath = `${finalPath}.assembling`;
  await fsp.mkdir(path.dirname(finalPath), { recursive: true });

  const hash = crypto.createHash('sha256');
  let bytes = 0;
  let out = null;

  try {
    if (manifest.storedRel) {
      const sourcePath = uploadAssemblyPath(manifest);
      const stat = await fsp.stat(sourcePath);
      if (stat.size !== manifest.size) {
        return sendJson(res, 400, { error: 'bad_upload_size', expected: manifest.size, received: stat.size });
      }
      for await (const chunk of fs.createReadStream(sourcePath, { highWaterMark: STREAM_HIGH_WATER_MARK })) {
        bytes += chunk.length;
        hash.update(chunk);
      }
      await fsp.mkdir(path.dirname(path.join(FILE_DIR, manifest.storedRel)), { recursive: true });
      await fsp.rename(sourcePath, path.join(FILE_DIR, manifest.storedRel));
    } else {
      out = fs.createWriteStream(tmpPath, { flags: 'wx', highWaterMark: STREAM_HIGH_WATER_MARK });
      for (let index = 0; index < manifest.totalChunks; index += 1) {
        for await (const chunk of fs.createReadStream(chunkPath(uploadId, index), { highWaterMark: STREAM_HIGH_WATER_MARK })) {
          bytes += chunk.length;
          hash.update(chunk);
          if (!out.write(chunk)) {
            await waitForDrain(out);
          }
        }
      }
      const finished = new Promise((resolve, reject) => {
        out.once('finish', resolve);
        out.once('error', reject);
      });
      out.end();
      await finished;
      if (bytes !== manifest.size) {
        await fsp.rm(tmpPath, { force: true }).catch(() => {});
        return sendJson(res, 400, { error: 'bad_upload_size', expected: manifest.size, received: bytes });
      }
      await fsp.rename(tmpPath, finalPath);
    }
  } catch (error) {
    out?.destroy();
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }

  const file = {
    id,
    name: manifest.name,
    storedRel,
    size: bytes,
    mime: inferMime(manifest.name, manifest.mime),
    sha256: hash.digest('hex'),
    source: manifest.publicUpload ? 'public' : 'admin',
    expiresAt: manifest.expiresAt || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    downloads: 0
  };

  db.files[id] = file;
  let share = null;
  if (manifest.publicUpload) {
    share = createShare(file, { expiresAt: manifest.expiresAt });
  }
  db.stats.totalUploads = (db.stats.totalUploads || 0) + 1;
  db.stats.totalBytesUploaded = (db.stats.totalBytesUploaded || 0) + bytes;
  await saveDb();
  scheduleFileExpiry(file);
  await deleteUploadSession(uploadId, manifest);
  if (manifest.publicUpload) {
    return sendJson(res, 201, {
      file: fileView(file),
      share: shareView(share),
      shareUrl: `/s/${share.token}`,
      directUrl: directDownloadUrl(share),
      expiresAt: file.expiresAt
    });
  }
  return sendJson(res, 201, fileView(file));
}

function uploadPath(uploadId) {
  return path.join(UPLOAD_DIR, uploadId);
}

function chunksPath(uploadId) {
  return path.join(uploadPath(uploadId), 'chunks');
}

function manifestPath(uploadId) {
  return path.join(uploadPath(uploadId), 'manifest.json');
}

function chunkPath(uploadId, index) {
  return path.join(chunksPath(uploadId), `${String(index).padStart(8, '0')}.part`);
}

async function readUploadManifest(uploadId) {
  try {
    return JSON.parse(await fsp.readFile(manifestPath(uploadId), 'utf8'));
  } catch {
    return null;
  }
}

async function writeUploadManifest(uploadId, manifest) {
  await atomicWriteJson(manifestPath(uploadId), manifest);
}

function expectedChunkSize(manifest, index) {
  if (manifest.size === 0) {
    return 0;
  }
  if (index === manifest.totalChunks - 1) {
    return manifest.size - (manifest.chunkSize * index);
  }
  return manifest.chunkSize;
}

async function receivedChunks(uploadId, manifest) {
  const received = [];
  for (let index = 0; index < manifest.totalChunks; index += 1) {
    try {
      const stat = await fsp.stat(chunkPath(uploadId, index));
      if (manifest.storedRel ? stat.isFile() : stat.size === expectedChunkSize(manifest, index)) {
        received.push(index);
      }
    } catch {
      // Missing chunks are returned by omission.
    }
  }
  return received;
}

async function uploadStatusView(uploadId, manifest) {
  const received = await receivedChunks(uploadId, manifest);
  return {
    ...uploadInitView(uploadId, manifest),
    received
  };
}

function uploadInitView(uploadId, manifest) {
  return {
    uploadId,
    name: manifest.name,
    size: manifest.size,
    mime: manifest.mime,
    chunkSize: manifest.chunkSize,
    totalChunks: manifest.totalChunks,
    received: [],
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt
  };
}

function waitForDrain(stream) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off('drain', onDrain);
      stream.off('error', onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    stream.once('drain', onDrain);
    stream.once('error', onError);
  });
}

function isConnectionAbort(error) {
  return error?.code === 'ECONNRESET'
    || error?.code === 'ABORT_ERR'
    || error?.name === 'AbortError'
    || error?.message === 'aborted';
}

function isSafeUploadId(uploadId) {
  return typeof uploadId === 'string' && /^[0-9a-f-]{36}$/i.test(uploadId);
}

function canAccessUpload(manifest, options = {}) {
  return Boolean(manifest.publicUpload) === Boolean(options.publicUpload);
}

async function handleFilesApi(req, res, requestUrl, parts) {
  if (parts.length === 2 && req.method === 'GET') {
    return sendJson(res, 200, {
      stats: statsView(),
      files: Object.values(db.files)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(fileView)
    });
  }

  if (parts.length === 2 && (req.method === 'PUT' || req.method === 'POST')) {
    return uploadFile(req, res, requestUrl);
  }

  const fileId = parts[2];
  const file = fileId ? db.files[fileId] : null;
  if (!file) {
    return sendJson(res, 404, { error: 'file_not_found' });
  }

  if (parts.length === 3 && req.method === 'PATCH') {
    const body = await readJson(req);
    const nextName = cleanDisplayName(body?.name);
    if (!nextName) {
      return sendJson(res, 400, { error: 'name_required' });
    }
    file.name = nextName;
    file.mime = inferMime(nextName, file.mime);
    file.updatedAt = new Date().toISOString();
    await saveDb();
    return sendJson(res, 200, fileView(file));
  }

  if (parts.length === 3 && req.method === 'DELETE') {
    await deleteFile(file);
    return sendJson(res, 200, { ok: true });
  }

  if (parts[3] === 'download' && (req.method === 'GET' || req.method === 'HEAD')) {
    return streamStoredFile(req, res, file, { download: true, cache: 'private, max-age=0' });
  }

  if (parts[3] === 'raw' && (req.method === 'GET' || req.method === 'HEAD')) {
    return streamStoredFile(req, res, file, { download: false, cache: 'private, max-age=0' });
  }

  if (parts[3] === 'shares' && req.method === 'GET') {
    return sendJson(res, 200, sharesForFile(file.id));
  }

  if (parts[3] === 'shares' && req.method === 'POST') {
    const body = await readJson(req);
    const share = createShare(file, body || {});
    await saveDb();
    return sendJson(res, 201, shareView(share));
  }

  return sendJson(res, 404, { error: 'not_found' });
}

async function uploadFile(req, res, requestUrl) {
  const name = cleanDisplayName(requestUrl.searchParams.get('name') || req.headers['x-file-name']);
  if (!name) {
    return sendJson(res, 400, { error: 'name_required' });
  }

  const id = crypto.randomUUID();
  const storedRel = `${id.slice(0, 2)}/${id}`;
  const storedPath = path.join(FILE_DIR, storedRel);
  const tmpPath = `${storedPath}.uploading`;
  await fsp.mkdir(path.dirname(storedPath), { recursive: true });

  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    }
  });

  const out = fs.createWriteStream(tmpPath, { flags: 'wx', highWaterMark: STREAM_HIGH_WATER_MARK });

  try {
    await pipeline(req, meter, out);
    await fsp.rename(tmpPath, storedPath);
  } catch (error) {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }

  const file = {
    id,
    name,
    storedRel,
    size: bytes,
    mime: inferMime(name, req.headers['content-type']),
    sha256: hash.digest('hex'),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    downloads: 0
  };

  db.files[id] = file;
  db.stats.totalUploads = (db.stats.totalUploads || 0) + 1;
  db.stats.totalBytesUploaded = (db.stats.totalBytesUploaded || 0) + bytes;
  await saveDb();
  return sendJson(res, 201, fileView(file));
}

async function deleteFile(file) {
  const timer = fileExpiryTimers.get(file.id);
  if (timer) {
    clearTimeout(timer);
    fileExpiryTimers.delete(file.id);
  }
  delete db.files[file.id];
  for (const [token, share] of Object.entries(db.shares)) {
    if (share.fileId === file.id) {
      delete db.shares[token];
    }
  }
  await saveDb();
  await fsp.rm(storedPath(file), { force: true }).catch(() => {});
}

async function purgeExpiredFiles() {
  const expired = Object.values(db.files).filter((file) => isExpiredFile(file));
  for (const file of expired) {
    await deleteFile(file);
  }
}

function uploadAssemblyPath(manifest) {
  return manifest?.storedRel ? path.join(FILE_DIR, `${manifest.storedRel}.uploading`) : null;
}

async function ensureUploadAssemblyFile(manifest) {
  const assemblyPath = uploadAssemblyPath(manifest);
  if (!assemblyPath) {
    return;
  }
  await fsp.mkdir(path.dirname(assemblyPath), { recursive: true });
  const handle = await fsp.open(assemblyPath, 'a');
  await handle.close();
}

async function deleteUploadSession(uploadId, manifest = null) {
  if (manifest?.storedRel) {
    await fsp.rm(uploadAssemblyPath(manifest), { force: true }).catch(() => {});
  }
  await fsp.rm(uploadPath(uploadId), { recursive: true, force: true });
}

async function purgeExpiredUploads() {
  let entries;
  try {
    entries = await fsp.readdir(UPLOAD_DIR, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }
    throw error;
  }

  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeUploadId(entry.name)) {
      continue;
    }
    const manifest = await readUploadManifest(entry.name);
    const lastActivity = await uploadSessionLastActivity(entry.name, manifest);
    if (now - lastActivity > UPLOAD_SESSION_TTL_MS) {
      await deleteUploadSession(entry.name, manifest);
    }
  }
}

async function uploadSessionLastActivity(uploadId, manifest) {
  let lastActivity = Date.parse(manifest?.updatedAt || manifest?.createdAt || '') || 0;
  const uploadDir = uploadPath(uploadId);
  const assemblyPath = uploadAssemblyPath(manifest);
  const pending = [latestMtime(uploadDir)];
  if (assemblyPath) {
    pending.push(latestMtime(assemblyPath));
  }
  for (const value of await Promise.all(pending)) {
    lastActivity = Math.max(lastActivity, value);
  }
  return lastActivity || Date.now();
}

async function latestMtime(targetPath) {
  try {
    const stat = await fsp.stat(targetPath);
    let latest = stat.mtimeMs;
    if (!stat.isDirectory()) {
      return latest;
    }
    const entries = await fsp.readdir(targetPath, { withFileTypes: true });
    for (const entry of entries) {
      latest = Math.max(latest, await latestMtime(path.join(targetPath, entry.name)));
    }
    return latest;
  } catch {
    return 0;
  }
}

function isExpiredFile(file) {
  return Boolean(file?.expiresAt) && new Date(file.expiresAt).getTime() <= Date.now();
}

function scheduleFileExpiryTimers() {
  for (const file of Object.values(db.files)) {
    scheduleFileExpiry(file);
  }
}

function scheduleFileExpiry(file) {
  if (!file?.id || !file.expiresAt) {
    return;
  }
  const existing = fileExpiryTimers.get(file.id);
  if (existing) {
    clearTimeout(existing);
  }
  const delay = new Date(file.expiresAt).getTime() - Date.now();
  if (delay <= 0) {
    deleteFile(file).catch(console.error);
    return;
  }
  const timer = setTimeout(() => {
    const current = db.files[file.id];
    if (current && isExpiredFile(current)) {
      deleteFile(current).catch(console.error);
    }
  }, delay);
  timer.unref();
  fileExpiryTimers.set(file.id, timer);
}

function createShare(file, options) {
  const token = generateGermanToken();
  const expiresAt = parseExpiry(options);
  const maxDownloads = Number.isFinite(Number(options.maxDownloads)) && Number(options.maxDownloads) > 0
    ? Math.floor(Number(options.maxDownloads))
    : null;
  const password = typeof options.password === 'string' && options.password.length > 0
    ? hashPassword(options.password)
    : null;

  const share = {
    token,
    fileId: file.id,
    createdAt: new Date().toISOString(),
    expiresAt,
    maxDownloads,
    downloadCount: 0,
    password,
    note: typeof options.note === 'string' ? options.note.slice(0, 200) : ''
  };
  db.shares[token] = share;
  return share;
}

async function handleShareRoute(req, res, requestUrl) {
  const parts = splitPath(requestUrl.pathname);
  const token = parts[1];
  if (!token) {
    return sendJson(res, 404, { error: 'not_found' });
  }

  if (parts.length === 2 && req.method === 'GET') {
    return servePublicFile(req, res, 'share.html', false);
  }

  if (parts[2] === 'info' && req.method === 'GET') {
    const validation = validateShare(req, token, false);
    if (!validation.ok) {
      return sendJson(res, validation.status, { error: validation.error });
    }
    const { share, file } = validation;
    return sendJson(res, 200, publicShareView(req, share, file));
  }

  if (parts[2] === 'auth' && req.method === 'POST') {
    const validation = validateShare(req, token, false);
    if (!validation.ok) {
      return sendJson(res, validation.status, { error: validation.error });
    }
    const { share } = validation;
    if (!share.password) {
      return sendJson(res, 200, { ok: true });
    }
    const body = await readJson(req);
    if (!verifyPassword(body?.password || '', share.password)) {
      return sendJson(res, 401, { error: 'invalid_password' });
    }
    setShareCookie(res, share);
    return sendJson(res, 200, { ok: true });
  }

  if (parts[2] === 'raw' && (req.method === 'GET' || req.method === 'HEAD')) {
    const validation = validateShare(req, token, true);
    if (!validation.ok) {
      return sendJson(res, validation.status, { error: validation.error });
    }
    return streamStoredFile(req, res, validation.file, { download: false, cache: 'private, max-age=300' });
  }

  if (parts[2] === 'download' && (req.method === 'GET' || req.method === 'HEAD')) {
    return streamShareDownload(req, res, token);
  }

  return sendJson(res, 404, { error: 'not_found' });
}

async function handleDirectDownload(req, res, requestUrl) {
  const token = splitPath(requestUrl.pathname)[1];
  if (!token || (req.method !== 'GET' && req.method !== 'HEAD')) {
    return sendJson(res, 404, { error: 'not_found' });
  }
  return streamShareDownload(req, res, token, requestUrl.searchParams.get('access') || '');
}

async function streamShareDownload(req, res, token, directAccess = '') {
  const validation = validateShare(req, token, true, directAccess);
  if (!validation.ok) {
    return sendJson(res, validation.status, { error: validation.error });
  }
  if (req.method === 'GET') {
    validation.share.downloadCount += 1;
    validation.file.downloads += 1;
    await saveDb();
  }
  return streamStoredFile(req, res, validation.file, { download: true, cache: 'private, max-age=300' });
}

function validateShare(req, token, requirePassword, directAccess = '') {
  const share = db.shares[token];
  if (!share) {
    return { ok: false, status: 404, error: 'share_not_found' };
  }
  const file = db.files[share.fileId];
  if (!file) {
    return { ok: false, status: 404, error: 'file_not_found' };
  }
  if (isExpiredFile(file)) {
    return { ok: false, status: 410, error: 'share_expired' };
  }
  if (share.expiresAt && new Date(share.expiresAt).getTime() <= Date.now()) {
    return { ok: false, status: 410, error: 'share_expired' };
  }
  if (share.maxDownloads && share.downloadCount >= share.maxDownloads) {
    return { ok: false, status: 410, error: 'download_limit_reached' };
  }
  if (requirePassword && share.password && !hasShareCookie(req, share) && !hasDirectAccess(share, directAccess)) {
    return { ok: false, status: 401, error: 'password_required' };
  }
  return { ok: true, share, file };
}

async function streamStoredFile(req, res, file, options) {
  const absolutePath = storedPath(file);
  let stat;
  try {
    stat = await fsp.stat(absolutePath);
  } catch {
    return sendJson(res, 404, { error: 'file_missing' });
  }

  const total = stat.size;
  const range = parseRange(req.headers.range, total);
  if (range?.invalid) {
    res.writeHead(416, {
      'Content-Range': `bytes */${total}`,
      'Accept-Ranges': 'bytes'
    });
    return res.end();
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : Math.max(total - 1, 0);
  const contentLength = total === 0 ? 0 : end - start + 1;
  const status = range ? 206 : 200;
  const headers = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': options.cache,
    'Content-Disposition': contentDisposition(file.name, options.download),
    'Content-Length': String(contentLength),
    'Content-Type': file.mime || inferMime(file.name),
    'ETag': `"${file.sha256 || file.id}-${total}"`,
    'Last-Modified': new Date(file.updatedAt || file.createdAt).toUTCString()
  };
  if (range) {
    headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
  }

  res.writeHead(status, headers);
  if (req.method === 'HEAD' || total === 0) {
    return res.end();
  }

  fs.createReadStream(absolutePath, {
    start,
    end,
    highWaterMark: STREAM_HIGH_WATER_MARK
  }).on('error', (error) => {
    res.destroy(error);
  }).pipe(res);
}

function parseRange(header, total) {
  if (!header) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match) {
    return { invalid: true };
  }
  if (total === 0) {
    return { invalid: true };
  }

  let start;
  let end;
  if (match[1] === '') {
    const suffixLength = Number.parseInt(match[2], 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return { invalid: true };
    }
    start = Math.max(total - suffixLength, 0);
    end = total - 1;
  } else {
    start = Number.parseInt(match[1], 10);
    end = match[2] === '' ? total - 1 : Number.parseInt(match[2], 10);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
    return { invalid: true };
  }
  return {
    start,
    end: Math.min(end, total - 1)
  };
}

async function servePublicFile(req, res, relativePath, cacheable) {
  const safeRelative = relativePath.replace(/^\/+/, '');
  const absolutePath = path.resolve(PUBLIC_DIR, safeRelative);
  if (!absolutePath.startsWith(`${PUBLIC_DIR}${path.sep}`) && absolutePath !== PUBLIC_DIR) {
    return sendJson(res, 403, { error: 'forbidden' });
  }

  let stat;
  try {
    stat = await fsp.stat(absolutePath);
  } catch {
    return sendJson(res, 404, { error: 'not_found' });
  }

  if (!stat.isFile()) {
    return sendJson(res, 404, { error: 'not_found' });
  }

  const etag = `"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304);
    return res.end();
  }

  res.writeHead(200, {
    'Cache-Control': cacheable ? 'public, max-age=3600' : 'no-store',
    'Content-Length': stat.size,
    'Content-Type': MIME_TYPES[path.extname(absolutePath).toLowerCase()] || 'application/octet-stream',
    'ETag': etag
  });
  if (req.method === 'HEAD') {
    return res.end();
  }
  fs.createReadStream(absolutePath).pipe(res);
}

function applyCors(req, res) {
  const origin = normalizeOrigin(req.headers.origin || '');
  if (!origin || !CORS_ORIGINS.has(origin)) {
    return false;
  }

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    req.headers['access-control-request-headers'] || 'Content-Type, X-File-Name, Range'
  );
  res.setHeader('Access-Control-Max-Age', '86400');
  appendVary(res, 'Origin');
  return true;
}

function appendVary(res, value) {
  const existing = res.getHeader('Vary');
  if (!existing) {
    res.setHeader('Vary', value);
    return;
  }
  const values = Array.isArray(existing) ? existing.join(', ') : String(existing);
  if (!values.split(',').map((item) => item.trim().toLowerCase()).includes(value.toLowerCase())) {
    res.setHeader('Vary', `${values}, ${value}`);
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > JSON_LIMIT) {
        reject(new Error('json_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
  });
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
    ...headers
  });
  res.end(body);
}

function sendNoContent(res, status) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': 0
  });
  res.end();
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function isAdmin(req) {
  const token = parseCookies(req).drop_session;
  if (!token) {
    return false;
  }
  const expiresAt = sessions.get(token);
  if (!expiresAt || expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return true;
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) {
      continue;
    }
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function setCookie(res, name, value, options = {}) {
  const pieces = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge) pieces.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.path) pieces.push(`Path=${options.path}`);
  if (options.domain || COOKIE_DOMAIN) pieces.push(`Domain=${options.domain || COOKIE_DOMAIN}`);
  if (options.httpOnly) pieces.push('HttpOnly');
  if (options.sameSite) pieces.push(`SameSite=${options.sameSite}`);
  if (process.env.DROP_COOKIE_SECURE === '1') pieces.push('Secure');
  const existing = res.getHeader('Set-Cookie');
  const next = Array.isArray(existing) ? existing.concat(pieces.join('; ')) : [pieces.join('; ')];
  res.setHeader('Set-Cookie', next);
}

function clearCookie(res, name, pathValue) {
  setCookie(res, name, '', {
    path: pathValue,
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: 0
  });
}

function setShareCookie(res, share) {
  setCookie(res, shareCookieName(share), shareCookieValue(share), {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: share.expiresAt
      ? Math.max(1, Math.floor((new Date(share.expiresAt).getTime() - Date.now()) / 1000))
      : 60 * 60 * 24 * 30
  });
}

function hasShareCookie(req, share) {
  const actual = parseCookies(req)[shareCookieName(share)];
  const expected = shareCookieValue(share);
  return safeEqual(actual || '', expected);
}

function shareCookieName(share) {
  return `drop_share_${share.token.slice(0, 12)}`;
}

function shareCookieValue(share) {
  return crypto
    .createHmac('sha256', db.config.sessionSecret)
    .update(`${share.token}:${share.password?.hash || ''}:${share.expiresAt || ''}`)
    .digest('base64url');
}

function directAccessToken(share) {
  if (!share.password) {
    return '';
  }
  const shareExpiry = share.expiresAt ? new Date(share.expiresAt).getTime() : Number.POSITIVE_INFINITY;
  const expiresAt = Math.floor(Math.min(Date.now() + DIRECT_ACCESS_TTL_MS, shareExpiry) / 1000);
  const signature = crypto
    .createHmac('sha256', db.config.sessionSecret)
    .update(`direct:${share.token}:${expiresAt}:${share.password.hash}`)
    .digest('base64url');
  return `${expiresAt}.${signature}`;
}

function hasDirectAccess(share, value) {
  if (!share.password || typeof value !== 'string') {
    return false;
  }
  const match = /^(\d+)\.([A-Za-z0-9_-]+)$/.exec(value);
  if (!match) {
    return false;
  }
  const expiresAt = Number(match[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt * 1000 <= Date.now()) {
    return false;
  }
  const expected = crypto
    .createHmac('sha256', db.config.sessionSecret)
    .update(`direct:${share.token}:${expiresAt}:${share.password.hash}`)
    .digest('base64url');
  return safeEqual(match[2], expected);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  return {
    algorithm: 'pbkdf2-sha256',
    iterations: PBKDF2_ITERATIONS,
    salt,
    hash: crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, 'sha256').toString('base64url')
  };
}

function verifyPassword(password, record) {
  if (!record?.hash || !record?.salt) {
    return false;
  }
  const candidate = crypto
    .pbkdf2Sync(password, record.salt, record.iterations || PBKDF2_ITERATIONS, 32, 'sha256')
    .toString('base64url');
  return safeEqual(candidate, record.hash);
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function cleanDisplayName(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const cleaned = value
    .replace(/[\0\r\n]/g, '')
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
  return cleaned.slice(0, 512);
}

function inferMime(name, provided) {
  if (typeof provided === 'string' && provided && provided !== 'application/octet-stream') {
    return provided.split(';')[0].trim().toLowerCase();
  }
  return MIME_TYPES[path.extname(name || '').toLowerCase()] || 'application/octet-stream';
}

function storedPath(file) {
  return path.join(FILE_DIR, file.storedRel);
}

function fileView(file) {
  const shares = sharesForFile(file.id);
  return {
    id: file.id,
    name: file.name,
    size: file.size,
    mime: file.mime,
    sha256: file.sha256,
    source: file.source || 'admin',
    expiresAt: file.expiresAt || null,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    downloads: file.downloads || 0,
    preview: previewType(file),
    shares
  };
}

function shareView(share) {
  return {
    token: share.token,
    fileId: share.fileId,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    maxDownloads: share.maxDownloads,
    downloadCount: share.downloadCount || 0,
    passwordProtected: Boolean(share.password),
    note: share.note || '',
    directUrl: directDownloadUrl(share, { authorize: true })
  };
}

function publicShareView(req, share, file) {
  const authorized = !share.password || hasShareCookie(req, share);
  return {
    token: share.token,
    name: file.name,
    size: file.size,
    mime: file.mime,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    maxDownloads: share.maxDownloads,
    downloadCount: share.downloadCount || 0,
    passwordRequired: Boolean(share.password),
    authorized,
    preview: authorized ? previewType(file) : null,
    directUrl: authorized ? directDownloadUrl(share, { authorize: true }) : null
  };
}

function sharesForFile(fileId) {
  return Object.values(db.shares)
    .filter((share) => share.fileId === fileId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(shareView);
}

function previewType(file) {
  const mime = file.mime || '';
  if (isCodeFile(file.name, mime)) return 'code';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('text/')) return 'text';
  return null;
}

function isCodeFile(name, mime) {
  const lowerMime = (mime || '').split(';')[0].toLowerCase();
  if (
    lowerMime.includes('javascript') ||
    lowerMime.includes('typescript') ||
    lowerMime.includes('json') ||
    lowerMime.includes('xml') ||
    lowerMime.includes('yaml') ||
    lowerMime.includes('toml') ||
    lowerMime.includes('sql') ||
    lowerMime.includes('shellscript') ||
    lowerMime.includes('x-python') ||
    lowerMime.includes('x-ruby') ||
    lowerMime.includes('x-go') ||
    lowerMime.includes('x-rust') ||
    lowerMime.includes('x-java') ||
    lowerMime.includes('x-c')
  ) {
    return true;
  }
  const basename = path.posix.basename(String(name || '')).toLowerCase();
  if (['dockerfile', 'makefile', 'justfile', 'rakefile', 'gemfile'].includes(basename)) {
    return true;
  }
  const codeExtensions = new Set([
    '.bash', '.c', '.conf', '.cpp', '.cs', '.css', '.dockerignore', '.env',
    '.go', '.h', '.hpp', '.html', '.ini', '.java', '.js', '.json', '.jsx',
    '.kt', '.kts', '.lua', '.md', '.mjs', '.php', '.properties', '.py',
    '.rb', '.rs', '.scss', '.sh', '.sql', '.svelte', '.swift', '.toml',
    '.ts', '.tsx', '.vue', '.xml', '.yaml', '.yml', '.zsh'
  ]);
  return codeExtensions.has(path.extname(basename));
}

function statsView() {
  const files = Object.values(db.files);
  const shares = Object.values(db.shares);
  return {
    fileCount: files.length,
    shareCount: shares.length,
    activeShareCount: shares.filter((share) => !share.expiresAt || new Date(share.expiresAt).getTime() > Date.now()).length,
    storedBytes: files.reduce((sum, file) => sum + (file.size || 0), 0),
    downloads: files.reduce((sum, file) => sum + (file.downloads || 0), 0),
    totalUploads: db.stats.totalUploads || files.length,
    totalBytesUploaded: db.stats.totalBytesUploaded || 0
  };
}

function parseExpiry(options) {
  if (typeof options.expiresAt === 'string' && options.expiresAt) {
    const timestamp = new Date(options.expiresAt).getTime();
    if (Number.isFinite(timestamp) && timestamp > Date.now()) {
      return new Date(timestamp).toISOString();
    }
  }
  const seconds = Number(options.expiresInSeconds);
  if (Number.isFinite(seconds) && seconds > 0) {
    return new Date(Date.now() + seconds * 1000).toISOString();
  }
  return null;
}

function contentDisposition(name, download) {
  const basename = path.posix.basename(name || 'download.bin');
  const fallback = basename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '');
  const encoded = encodeURIComponent(basename).replace(/['()]/g, escape).replace(/\*/g, '%2A');
  return `${download ? 'attachment' : 'inline'}; filename="${fallback || 'download.bin'}"; filename*=UTF-8''${encoded}`;
}

function safeUrl(req) {
  try {
    return new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  } catch {
    return null;
  }
}

function normalizeBaseUrl(value) {
  const origin = normalizeOrigin(value);
  return origin || '';
}

function normalizeDirectDownloadAddress(value) {
  const input = String(value || '').trim();
  if (!input) {
    return '';
  }
  const hasProtocol = /^https?:\/\//i.test(input);
  let candidate = input;
  if (!hasProtocol) {
    if (isIP(input) === 6) {
      candidate = `http://[${input}]:${PORT}`;
    } else {
      candidate = `http://${input}`;
    }
  }
  try {
    const url = new URL(candidate);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:')
      || url.username
      || url.password
      || (url.pathname !== '/' && url.pathname !== '')
      || url.search
      || url.hash) {
      return '';
    }
    if (!hasProtocol && !url.port) {
      url.port = String(PORT);
    }
    return url.origin;
  } catch {
    return '';
  }
}

function activeDirectDownloadOrigin() {
  if (db.config.directDownloadsEnabled !== true) {
    return '';
  }
  return normalizeDirectDownloadAddress(db.config.directDownloadOrigin);
}

function downloadSettingsView() {
  return {
    directDownloadsEnabled: db.config.directDownloadsEnabled === true,
    directDownloadAddress: db.config.directDownloadOrigin || '',
    activeDirectDownloadOrigin: activeDirectDownloadOrigin()
  };
}

function directDownloadUrl(share, options = {}) {
  const pathname = `/d/${encodeURIComponent(share.token)}`;
  const access = options.authorize ? directAccessToken(share) : '';
  const suffix = access ? `?access=${encodeURIComponent(access)}` : '';
  return `${activeDirectDownloadOrigin()}${pathname}${suffix}`;
}

function normalizeOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return '';
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return '';
    }
    return url.origin;
  } catch {
    return '';
  }
}

function cleanCookieDomain(value) {
  const domain = String(value || '').trim().toLowerCase();
  if (!domain || !/^\.?[a-z0-9.-]+$/.test(domain)) {
    return '';
  }
  return domain;
}

function csvValues(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitPath(pathname) {
  return pathname
    .split('/')
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return '';
      }
    });
}
