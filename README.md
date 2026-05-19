# JaffDrop 🚀

Fast, lightweight, and self-hosted file sharing service. Powers `drop.jaffcloud.uk`.

---

## 🚀 Highlights

- **Performance-First**: Zero dependencies, built with native Node.js modules for maximum speed and a minimal footprint.
- **Large File Support**: Resumable chunked uploads (8 MiB chunks) handle files of virtually any size.
- **Automatic Expiry**: Public uploads automatically expire after 7 days to keep your storage clean.
- **Secure Sharing**:
    - Optional password protection for every share.
    - Set download limits and expiry timestamps.
    - Admin dashboard for full control.
- **Rich Previews**: Native support for viewing images, videos, audio, PDFs, and syntax-highlighted code directly in the browser.
- **Direct Access**: Permanent direct download links via `/d/:token`.
- **Insights**: Real-time stats on storage usage, download counts, and upload activity.

---

## 🛠️ Tech Stack

- **Backend**: Node.js 20+ (Native `http`, `fs`, `crypto` modules)
- **Frontend**: Vanilla JS & CSS (Inter font, dark mode)
- **Database**: Atomic JSON-based storage (`db.json`)

---

## 📦 Quick Start

### Installation

```bash
git clone git@github.com:J4FF/drop.jaffcloud.uk.git
cd drop.jaffcloud.uk
npm start
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DROP_PORT` | Port to listen on | `8787` |
| `DROP_HOST` | Host to bind to | `0.0.0.0` |
| `DROP_DATA_DIR` | Directory for DB and logs | `./data` |
| `DROP_FILE_DIR` | Directory for stored files | `./storage/files` |
| `DROP_PUBLIC_ORIGIN` | Public URL of the service | |
| `DROP_UPLOAD_BASE_URL` | Direct upload origin (bypass Cloudflare) | |

---

## ⚙️ Deployment

### Systemd

1. Copy the service file:
   ```bash
   sudo cp jaffdrop.service /etc/systemd/system/
   ```
2. Reload and start:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now jaffdrop
   ```

### Reverse Proxy (Caddy)

```caddy
drop.jaffcloud.uk {
    reverse_proxy localhost:8787
}
```

---

## 🛡️ Security

- **Admin Auth**: Password is generated on first run and stored in `data/admin-password.txt`.
- **Data Integrity**: SHA-256 metadata for every file.
- **Hardened Headers**: `X-Content-Type-Options: nosniff` and timing-safe comparisons for auth.

---
Built with ❤️ by [Jaff](https://github.com/J4FF)
