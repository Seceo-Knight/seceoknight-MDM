# CyberSentinel MDM — Server

The backend for the CyberSentinel MDM platform: a set of Go microservices, a
React admin console, and the infrastructure they need (Postgres, Redis, NATS,
MQTT, object storage, metrics). Everything runs from a single `docker compose`
file — the only thing you install on the host is **Docker**.

> Provisioning a real Android device (QR flow, signing checksum, ngrok) is
> covered separately in [`../SETUP.md`](../SETUP.md). This README is just about
> standing up the server.

---

## Quick start

```bash
cd server
cp .env.example .env          # then edit secrets (see below)
docker compose up -d          # builds images on first run (~several min)
```

Open the admin console at **http://localhost:8080** (also served on `:80`). The
port is configurable — set `WEB_PORT` in `.env` (see [Changing the access port](#changing-the-access-port)).

**Default login:** `admin@mdm.local` / `ChangeMe!123` — change it on first sign-in.
These are just the **defaults**; the initial super-admin is set from
`SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` in `.env` and is **not hardcoded**
anywhere (see [Changing the super-admin login](#changing-the-super-admin-login)).

That's it. On a fresh data volume the stack self-initializes: it runs every SQL
migration, seeds the default tenant, and creates the super-admin from those env
vars automatically (its password is bcrypt-hashed at seed time, never stored in
plaintext).

---

## What you get

| Service | Port | Purpose |
|---------|------|---------|
| **admin-web** (nginx + React) | `${WEB_PORT:-8080}`, `${WEB_PORT_HTTP:-80}` | the console UI + reverse proxy for the API and MQTT-over-WebSocket |
| auth-service | `8001` | login, JWT issue/refresh, users, RBAC |
| device-service | `8002` | enrollment, device state, heartbeats, time-travel snapshots |
| policy-service | `8003` | policy definitions + assignment |
| command-service | `8004` | remote commands (lock, wipe, locate, camera, mic…) |
| telemetry-service | `8005` | device telemetry ingestion |
| notification-service | `8006` | **WebRTC screen-share signaling** (`/ws/signal`, per-`(tenant,device)` room) + **TURN credentials** (`GET /api/v1/stream/turn`); admin event WS; NATS/MQTT bridge (dormant) |
| file-service | `8007` | APK hosting, photo/audio/**screen** captures, log bundles (MinIO-backed) |
| audit-service | `8008` | hash-chained audit log |

Command delivery to devices is **HTTP long-poll** on command-service (the agent holds `/commands/poll` open ~20 s; the server returns the moment a command is queued). MQTT/Mosquitto is retained but **dormant** — it was unreliable on OEM-frozen radios.

Supporting infra: **Postgres 16**, **Redis 7**, **NATS** (`4222`), **Mosquitto**
(`1883` TCP / `9001` WebSocket, dormant), **MinIO** (`9000` API / `9101` console),
**coturn** (`3478` TURN/STUN + relay range `49160-49200`, host networking — for the WebRTC screen mirror),
**Prometheus** (`9090`), **Grafana** (`3001`, admin/admin), and a Traefik
dashboard (`8081`).

All services speak to each other by name on the `mdm` bridge network. The
browser only ever talks to **admin-web on `WEB_PORT` (default `:8080`)**, which
proxies `/api/v1/*` to the right service and bridges `wss://…/mqtt` to Mosquitto
— so a single port is all you need to expose. Every host port above is set by an
env var with the shown default, so nothing is hardcoded — see
[Changing the access port](#changing-the-access-port).

---

## Configuration

Copy `.env.example` → `.env` and set at least these before anything real:

| Variable | Why it matters |
|----------|----------------|
| `JWT_SECRET` | **MUST replace.** Signs every access/refresh token. Use `openssl rand -base64 48`. |
| `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` | The initial super-admin login, seeded once on a fresh DB. **MUST replace the password.** Not hardcoded — see [Changing the super-admin login](#changing-the-super-admin-login). |
| `WEB_PORT` / `WEB_PORT_HTTP` | The published console port (default `8080`) + the plain-`:80` convenience binding. See [Changing the access port](#changing-the-access-port). |
| `POSTGRES_PASSWORD` | DB password (user is fixed to `mdm`). |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | **MUST replace** — `minioadmin/minioadmin` is a known-public default. |
| `MQTT_USER` / `MQTT_PASS` | Credentials for the (dormant) MQTT broker. |
| `PUBLIC_BASE_URL` | The URL baked into QR enrollment payloads + the APK download link — must be reachable from the **device's** network (see `../SETUP.md`). Its **port must match `WEB_PORT`**. If the host IP moves, run `./set-server-ip.sh <ip>` (updates this, `TURN_URL`, `MINIO_PUBLIC_ENDPOINT` + the DB in one shot). |
| `TURN_SECRET` / `TURN_URL` | coturn shared secret + the `turn:<host>:3478` URL handed to the agent/browser for the screen mirror. **`TURN_URL` host must match `PUBLIC_BASE_URL`** — `./set-server-ip.sh` now keeps it in sync automatically (it recreates notification-service so the change takes effect). |

Every infra host port (`POSTGRES_PORT`, `GRAFANA_PORT`, `MINIO_PORT`, …) is also
an env var defaulting to its current value — see `.env.example`. Sensible dev
defaults are wired into `docker-compose.yml`, so the stack boots without a `.env`
at all — but those defaults are **not** safe for production.

### Changing the access port

`WEB_PORT` is the single port the whole setup is reached on (browser, API, and
the MQTT-over-WebSocket bridge all come through nginx there). To move it:

```bash
# in server/.env
WEB_PORT=9090
PUBLIC_BASE_URL=http://<host>:9090   # the port here MUST match WEB_PORT
```

```bash
docker compose up -d        # republishes admin-web on the new port
```

`WEB_PORT_HTTP` (default `80`) is an extra binding so the agent's bare
`http://<host>` URL (no port) keeps working; set it equal to `WEB_PORT` if you
don't want the `:80` convenience. Because `PUBLIC_BASE_URL` is what gets baked
into enrollment payloads and handed to agents, **always change it alongside
`WEB_PORT`** (and re-point already-enrolled devices via the Dev Console →
**Test & reconnect**).

### Changing the super-admin login

The first user is created from `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` by
[`infra/migrations/010_seed_superadmin.sh`](infra/migrations/010_seed_superadmin.sh),
which hashes the password with bcrypt (cost 12) **at seed time** via Postgres
`pgcrypto` — no credential is ever hardcoded in SQL or baked into an image.

Like every migration, it runs **only on a fresh database** (empty
`./infra/pgdata`). So:

- **Before first `up`** (or after a deliberate reset): just set the two vars in
  `.env`, then `docker compose up -d`.
- **On an already-running stack:** the seed won't re-run. Either change the
  password from the admin console, or update it in place:

  ```bash
  docker compose exec postgres \
    psql -U mdm -d mdm -v pw='your-new-password' \
    -c "UPDATE users SET password_hash = crypt(:'pw', gen_salt('bf',12)) WHERE email='admin@mdm.local';"
  ```

- **To re-seed from scratch** (⚠️ destroys all data): `rm -rf ./infra/pgdata`
  (the DB is a host bind-mount, so `down -v` alone won't clear it), then
  `docker compose up -d`.

---

## Database & migrations

Migrations live in [`infra/migrations/`](infra/migrations) and are mounted into
Postgres at `/docker-entrypoint-initdb.d`. Postgres runs them **once, only when
the data volume is empty** — i.e. on a truly fresh start.

If you add a migration to an **already-running** DB, apply it by hand:

```bash
docker compose exec -T postgres psql -U mdm -d mdm < infra/migrations/0XX_whatever.sql
```

To wipe and start completely fresh (⚠️ destroys all data):

```bash
docker compose down -v && docker compose up -d
```

---

## Everyday commands

```bash
docker compose ps                          # service health
docker compose logs -f device-service      # follow one service (enroll/heartbeat live here)
docker compose up -d --build device-service # rebuild + restart a single service after a code change
docker compose restart admin-web           # pick up new nginx.conf / rebuilt UI
docker compose down                         # stop (keeps data); add -v to also drop volumes
```

The admin UI is built **inside** the `admin-web` image, so after changing
frontend code, rebuild it:

```bash
docker compose up -d --build admin-web
```

For a faster frontend inner loop you can run Vite directly against the running
API instead:

```bash
cd admin-web && npm install && npm run dev      # http://localhost:5173
```

---

## Project layout

```
server/
├── docker-compose.yml      # the whole stack
├── .env.example            # copy to .env
├── admin-web/              # React + Vite + Tailwind console (also the nginx gateway)
├── shared/                 # shared Go models, authz matrix, middleware
├── auth-service/ … audit-service/   # one Go module per microservice
└── infra/
    ├── migrations/         # SQL, auto-applied on fresh volume
    ├── mosquitto/          # MQTT broker config
    ├── prometheus/         # scrape config
    └── grafana/            # dashboards
```

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Console loads but login fails | Stack still booting — `docker compose ps` until services are healthy; check `docker compose logs auth-service`. |
| Schema looks empty / migrations didn't run | They only auto-run on an **empty** volume. Either `down -v` for a fresh start, or apply by hand (see above). |
| Changed the UI but don't see it | Rebuild the image: `docker compose up -d --build admin-web`. |
| A device enrolls but shows **Disconnected** | Heartbeat (HTTP long-poll, not MQTT) drives online state. Usually the **server IP moved** (DHCP) and the agent still points at the old one — fix the server with `./set-server-ip.sh <new-ip>` (+ `TURN_URL` by hand), then on the phone Dev Console → **Test & reconnect** (hard-restarts the agent loops). A **static IP/hostname** prevents recurrence. |
| Screen mirror stuck on "Waiting for device" | (1) `GET /api/v1/stream/turn` must return your current IP — check `TURN_URL`; (2) the agent's accessibility service (**Permissions → Screen capture**) must be enabled so the MediaProjection consent auto-confirms; (3) watch `docker compose logs -f notification-service` for `signal: register role=device` + `relay`. |
| Screen mirror goes black / drops when the phone screen turns off | Expected — MediaProjection only captures while the display is rendering. Click **Wake** on the Screen tab (issues `WAKE_DEVICE`) to turn the screen back on and revive the feed; it's Device-Owner-gated and tiered as a `surveillance` command. |
| Screen recording didn't save | The DB `file_objects_kind_check` must allow `screen` — apply `infra/migrations/019_files_screen_kind.sql` on existing volumes. |
| Presigned file URLs don't resolve for a remote browser | Set `MINIO_PUBLIC_ENDPOINT` to a host the browser can reach. |

For device provisioning, signing-checksum, and ngrok exposure, see
[`../SETUP.md`](../SETUP.md).
