# CyberSentinel MDM — Setup Guide

How to stand up the platform and provision an Android device from a **fresh
machine**. The host only needs **Docker**, **git**, and (for remote
provisioning) **ngrok**. Everything else — JDK, Android SDK, Node, Go — runs
inside containers, so you never install a toolchain.

---

## 0. Prerequisites

| Tool | Why | Install check |
|------|-----|---------------|
| Docker + Compose v2 | runs every service **and** builds the APK | `docker compose version` |
| git | clone the repo | `git --version` |
| ngrok | expose the server to a real phone over HTTPS (skip if the phone is on the same LAN and can reach the host IP) | `ngrok version` |

---

## 1. Clone and start the server

```bash
git clone <repo-url> mdm
cd mdm/server
docker compose up -d        # builds images on first run (~several min)
```

On a **fresh data volume** this automatically:

- runs every SQL migration in `server/infra/migrations/` (mounted at
  `/docker-entrypoint-initdb.d`, which Postgres executes once, only when the
  volume is empty) — including `enrollment_config`;
- seeds the default tenant and the super-admin user from the
  `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` env vars (bcrypt-hashed at seed
  time — nothing is hardcoded).

> Migrations only auto-run on an **empty** volume. If you add migrations to an
> **existing** DB, apply them by hand (`docker compose exec -T postgres psql …`).
> The same goes for the super-admin: changing `SUPERADMIN_*` only takes effect on
> a fresh DB — see [`server/README.md`](server/README.md#changing-the-super-admin-login).

**Default login:** `admin@mdm.local` / `ChangeMe!123` — set your own via
`SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` in `server/.env` before the first
`docker compose up`, and change it immediately on any existing deployment.

Admin UI: `http://<host>:8080` (the port is `WEB_PORT` in `server/.env`; change
it there — and in `PUBLIC_BASE_URL` — to move the whole setup to another port).

---

## 2. The debug signing keystore (read this — it controls the QR checksum)

The agent APK is signed with a keystore. Android's QR provisioning embeds a
**signature checksum** (`PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM`) that
must match the signing cert of the APK the device downloads, or provisioning
fails with *"Can't set up device — contact your IT admin."*

`build-apk.sh` **pins a stable keystore** so the checksum never drifts:

- The key lives at **`android-agent/.signing/debug.keystore`** (gitignored).
- On first build, the script generates it with the canonical AOSP debug
  credentials — alias `androiddebugkey`, store/key password `android` — and
  mounts it into the build container at `~/.android/debug.keystore`, so Gradle's
  default debug `signingConfig` reuses it on every build.
- **Same keystore ⇒ same signing cert ⇒ same checksum, forever.**

### Keeping the checksum identical across machines

The keystore is **local to whatever machine built it**. On a new machine the
first build mints a *new* key and therefore a *new* checksum. To avoid that, do
**one** of:

- **(Recommended) Carry the keystore over.** Copy `android-agent/.signing/debug.keystore`
  from your existing machine to the same path on the new one *before* building.
  The checksum then matches everywhere.
- **Or recompute the checksum** on the new machine after building (see §4) and
  paste the new value into the UI config (§6).

> For production, replace the debug key with a real release keystore in
> `app/build.gradle.kts` and recompute the checksum from that.

---

## 3. Build the agent APK

```bash
cd mdm/android-agent
./build-apk.sh debug        # → app/build/outputs/apk/debug/app-debug.apk
```

First run builds the ~1.3 GB builder image and caches Gradle deps; later runs
finish in ~1 min. Output APK is ~19 MB.

---

## 4. Get the signature checksum

If you carried the keystore over (§2), the checksum is unchanged and you can
skip this. Otherwise compute it from the freshly built APK:

```bash
cd mdm/android-agent
python3 - <<'PY'
import struct, hashlib, base64
data = open('app/build/outputs/apk/debug/app-debug.apk','rb').read()
eocd = data.rfind(b'PK\x05\x06'); cd = struct.unpack_from('<I', data, eocd+16)[0]
assert data[cd-16:cd] == b'APK Sig Block 42', "not a v2-signed APK"
sz = struct.unpack_from('<Q', data, cd-24)[0]; start = cd-8-sz
p = start+8; end = cd-24; blocks = {}
while p < end:
    ln  = struct.unpack_from('<Q', data, p)[0]
    bid = struct.unpack_from('<I', data, p+8)[0]
    blocks[bid] = data[p+12:p+8+ln]; p += 8+ln
def lp(b, o):
    n = struct.unpack_from('<I', b, o)[0]; return b[o+4:o+4+n], o+4+n
v = blocks[0x7109871a]                      # APK Signature Scheme v2 block
signers, _ = lp(v, 0); signer, _ = lp(signers, 0); sd, _ = lp(signer, 0)
_, off = lp(sd, 0); certs, _ = lp(sd, off); cert, _ = lp(certs, 0)
print(base64.urlsafe_b64encode(hashlib.sha256(cert).digest()).decode().rstrip('='))
PY
```

This prints the URL-safe-base64 SHA-256 of the signing cert — the exact value the
UI's "Signature checksum" field expects.

> For the committed pinned keystore the checksum is
> `Zz_JfABzde8QCFJD5V8WiSbi1QmgMB4p58KSBbbt3oE`.

---

## 5. Host the APK and expose the server

### Host the APK (public HTTPS, direct download)

The device downloads the APK during provisioning, so it must be a **direct
HTTPS** link. Options:

- A **GitHub Release** asset (works well; the 302 → `objects.githubusercontent.com`
  redirect is followed by Android's downloader).
- Your own file-service / object storage.

> Google Drive / Dropbox *share* links do **not** work — they return HTML, not the
> APK bytes.

### Expose the server (ngrok)

A real phone can't reach `localhost`. Use ngrok (or a real domain + TLS):

```bash
ngrok config add-authtoken <YOUR_TOKEN>
ngrok http 8080 --domain=<your-reserved-domain>.ngrok-free.app
```

- Tunnel **port 8080** — that's nginx, which fronts the API **and** the
  MQTT-over-WebSocket path, so one tunnel covers everything.
- A **reserved** domain keeps the URL stable across restarts (free random URLs
  change every restart and force you to re-edit the config + QR).
- **Commands** flow over **HTTP long-poll** through the same `:8080` tunnel — no
  extra ports, no MQTT. (MQTT is retained but dormant.)
- **Live screen mirror (WebRTC)** is the exception: its media leg (SRTP) needs
  **coturn** (UDP `:3478` + relay range `49160-49200`) reachable from the device
  and the browser. On the **same LAN** this works via direct host ICE candidates
  with no extra setup. **Through an ngrok HTTP tunnel it won't carry the media** —
  so the screen mirror is effectively **LAN-only** unless you expose coturn on a
  public IP and point `TURN_URL` at it.

---

## 6. Configure provisioning in the UI

Log in as admin/super_admin → **Enrollment** → **Provisioning configuration**
(requires the `enroll:create` permission). Set:

| Field | Value |
|-------|-------|
| **Server base URL** | your public URL, e.g. `https://<domain>.ngrok-free.app` (with port if not 443). Never `localhost`. |
| **APK download URL** | the public HTTPS link from §5 |
| **Signature checksum** | the value from §2/§4 |
| **WiFi SSID / password / security** | a network the factory-reset device joins during setup so it can reach GitHub + the server. Use a throwaway provisioning network — anyone who photographs the QR can read the password. |
| Options | Skip encryption (usually off), Leave system apps (usually on) |

Save.

---

## 7. Provision a device

1. **Enrollment** → **Generate new token** → a scannable QR renders.
2. On a **factory-reset** device, tap the welcome screen **6 times** to open the
   QR reader, then scan.
3. The device joins WiFi → downloads + verifies the APK → becomes **Device
   Owner** → `ProvisioningActivity` reads the embedded server URL + token →
   auto-enrolls → starts heartbeating and connects over `wss`.

No manual server-URL/token entry should appear.

---

## 8. Updating the agent later (no factory reset)

Because the keystore is pinned, rebuilds keep the same signature, so you can
update in place:

```bash
./build-apk.sh debug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

A factory-reset re-provision is only needed when the **signing cert changes**
(new/lost keystore, or switching to a release key).

> Each in-place update makes Android re-show the **"keep accessibility on?"**
> confirmation (it fires whenever an app with an accessibility service is
> updated) — tap **keep on**. For the **live screen mirror**, enable the agent's
> accessibility service **once** (agent → Permissions → **Screen capture**, or
> Settings → Accessibility → CyberSentinel) so the MediaProjection consent
> auto-confirms; without it the consent dialog waits for a manual tap.

> **If the server's IP moved** (DHCP), the agent will sit **Disconnected** on the
> old address. Run `server/set-server-ip.sh <new-ip>` (and fix `TURN_URL` by
> hand), then on the phone open the agent's **Dev Console → Test & reconnect** —
> it hard-restarts the connection in-process (no reboot). A **static IP /
> hostname** for the server avoids the whole problem.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| *"Can't set up device — contact your IT admin"* during scan | checksum missing/wrong, or download URL unreachable / not a real APK | set the correct checksum (§4) and a direct-HTTPS APK URL; confirm the device's WiFi has internet |
| Device becomes owner but shows the **manual** server-URL/token screen | running an APK without `ProvisioningActivity` (pre-fix build), or the QR had no admin-extras bundle | rebuild from current source; regenerate the token/QR |
| Enrolls but stays **Disconnected** | HTTP long-poll heartbeats not reaching the server — usually the **server IP moved** (DHCP) and the agent points at the old one, or the OEM froze the agent | `server/set-server-ip.sh <ip>` (+ `TURN_URL` by hand) → agent **Dev Console → Test & reconnect**; watch `docker compose logs -f device-service` for `POST /devices/me/heartbeat`. Prefer a **static IP/hostname**. |
| Agent stuck "reconnecting", only a reboot fixes it | OnePlus/ColorOS deep-froze the foreground service (suspends its alarms/workers) | enable the OEM **Auto-launch/autostart** + set **Battery → Unrestricted** for the agent + lock it in Recents; use **Test & reconnect** to recover in-process |
| Screen mirror stuck on "Waiting for device" | TURN URL stale / consent not auto-confirmed | confirm `GET /api/v1/stream/turn` returns the current IP; enable the agent's **Screen capture** accessibility service once; check `docker compose logs -f notification-service` for `signal: register role=device` + `relay` |
| QR won't scan at all (camera won't lock on) | payload too dense at small size | already mitigated (error-correction L, large render, quiet zone); use the **Download QR** link and scan the full-size PNG if needed |

---

## Quick reference

```bash
# Server
cd mdm/server && docker compose up -d
docker compose logs -f device-service        # watch enroll / heartbeat
docker compose ps                            # service health

# Agent
cd mdm/android-agent && ./build-apk.sh debug
adb install -r app/build/outputs/apk/debug/app-debug.apk

# Tunnel
ngrok http 8080 --domain=<your-domain>.ngrok-free.app
```

Default admin: `admin@mdm.local` / `ChangeMe!123` (override via `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` in `server/.env`; change on first login). The console port is `WEB_PORT` (default `8080`).
