# JaffDrop

Fast self-hosted file sharing for `drop.jaffcloud.uk`.

## Run

```bash
cd /home/jaff/apps/drop
DROP_PORT=8787 npm start
```

The admin password is generated on first boot and stored in:

```text
/home/jaff/apps/drop/data/admin-password.txt
```

## Reverse proxy

Point `drop.jaffcloud.uk` to:

```text
http://127.0.0.1:8787
```

## Direct upload origin

To keep the UI behind Cloudflare Tunnel but send upload traffic directly to the Pi, expose a second hostname such as `upload.jaffcloud.uk` as DNS-only and point it at the router/Pi public address. Forward TCP 443 to an HTTPS reverse proxy on the Pi, then proxy that hostname to:

```text
http://127.0.0.1:8787
```

Start JaffDrop with:

```bash
DROP_PUBLIC_ORIGIN=https://drop.jaffcloud.uk \
DROP_UPLOAD_BASE_URL=https://upload.jaffcloud.uk \
DROP_COOKIE_DOMAIN=.jaffcloud.uk \
DROP_COOKIE_SECURE=1 \
DROP_PORT=8787 npm start
```

Keep `DROP_UPLOAD_BASE_URL` unset until `upload.jaffcloud.uk` is reachable over HTTPS. Otherwise browsers will try to upload to an origin that does not exist yet.

## Optional systemd install

```bash
sudo cp /home/jaff/apps/drop/jaffdrop.service /etc/systemd/system/jaffdrop.service
sudo systemctl daemon-reload
sudo systemctl enable --now jaffdrop
```

## Features

- Admin login
- Streaming uploads
- Large-file uploads through 8 MiB chunks
- Streaming downloads with HTTP range support
- Public share pages
- Public upload page at `/upload`; public uploads expire after 7 days
- Direct download links
- Optional link passwords
- Optional expiry and download limits
- Video, audio, image, PDF, and text preview
- File rename and delete
- SHA-256 metadata
