# SeceoKnight MDM — Server

The backend for the SeceoKnight MDM platform: a set of Go microservices, a
React admin console, and the infrastructure they need (Postgres, Redis, NATS,
MQTT, MinIO object storage, Prometheus metrics). Everything runs from a single
`docker compose` file — the only thing you install on the host is Docker.

> For the full deployment guide (server + APK build + device enrollment),
> see the [main README](../README.md).

---

## Quick start (development)

```bash
cd server
cp .env.example .env   # edit secrets if needed
docker compose up -d   # builds images on first run (~5 min)
```

Admin portal: `http://localhost` · Default login: `admin@mdm.local` / `ChangeMe!123`

---

## Services

| Service | Port | Description |
|---------|------|-------------|
| admin-web | 80 (via nginx) | React admin dashboard |
| auth-service | 8001 | JWT auth, MFA, user management |
| device-service | 8002 | Device registry, enrollment, commands |
| policy-service | 8003 | Policy CRUD and assignment |
| telemetry-service | 8004 | Heartbeats, telemetry, app inventory, AI anomalies |
| file-service | 8007 | APK and file storage (MinIO backed) |
| audit-service | 8008 | Immutable audit log |
| compliance-service | 8009 | Compliance rules engine |
| alert-service | 8010 | Alert channels and notifications |
| notification-service | 8011 | MQTT push to devices |
| command-service | 8012 | Command queue and delivery |

---

## Built by SeceoKnight Technologies
