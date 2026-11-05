#!/usr/bin/env bash
# set-server-ip.sh — repoint the WHOLE MDM stack at a new host IP in one step.
#
# Why this exists: the dev box gets its LAN address from DHCP, so the IP changes
# whenever the lease rotates or the machine moves networks. Several things must
# agree on that address or devices/enrollment/screen-mirror break:
#   1. PUBLIC_BASE_URL in .env           — baked into enrollment QR payloads,
#                                           policy_url and APK download links.
#   2. TURN_URL in .env                  — the coturn relay address handed to the
#                                           agent + admin browser for the WebRTC
#                                           screen mirror (this used to drift!).
#   3. MINIO_PUBLIC_ENDPOINT in .env     — fallback host for presigned object URLs
#                                           when no X-Forwarded-Host is present.
#   4. enrollment_config.server_base_url — the URL the QR/enroll flow hands out (DB).
#   5. The running Go containers         — they read the above from the env at boot.
# Editing these by hand (and forgetting one — usually TURN_URL) is exactly what
# kept stranding the fleet / breaking the mirror. This script does all of them.
#
# It does NOT use 0.0.0.0: these are CLIENT-facing destination addresses given to
# the phone/browser, not listen addresses. A client can't connect to 0.0.0.0 — it
# must be a concrete IP/host the device can route to. (The containers already
# listen on all interfaces internally.)
#
# Ports are read from .env so they stay consistent with WEB_PORT / MINIO_PORT:
#   - web port:   $PORT env  >  WEB_PORT in .env  >  port in current PUBLIC_BASE_URL  > 8080
#   - TURN port:  $TURN_PORT env  >  port in current TURN_URL  > 3478
#   - MinIO port: MINIO_PORT in .env  > 9000
#
# NOTE on already-enrolled devices: they target the IP stored on the phone, so
# you still repoint each phone once via Dev Console → Set Server URL. They will
# NOT need re-enrollment — the auth-service tolerates the in-flight token
# rotation that a server restart causes (recoverLostRotation in auth_service.go).
#
# Usage:
#   ./set-server-ip.sh            # auto-detect this host's primary LAN IP
#   ./set-server-ip.sh 10.0.0.42  # use an explicit IP/host
#   PORT=9090 ./set-server-ip.sh  # override the web port
set -euo pipefail

cd "$(dirname "$0")"
ENV_FILE=".env"
[[ -f "$ENV_FILE" ]] || { echo "ERROR: $ENV_FILE not found (run from server/, or cp .env.example .env first)." >&2; exit 1; }

# Read a KEY=value from .env (last wins); empty if absent.
envget() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true; }

# Set KEY=value in .env, replacing in place or appending if missing.
set_env() {
  local key="$1" val="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i -E "s#^${key}=.*#${key}=${val}#" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}

# --- resolve the target IP ---------------------------------------------------
if [[ $# -ge 1 ]]; then
  IP="$1"
else
  # Source IP of the default route = the real LAN interface, not docker bridges.
  IP="$(ip route get 1.1.1.1 2>/dev/null | grep -oP '(?<=src\s)\d+(\.\d+){3}' | head -1 || true)"
fi
if [[ -z "${IP:-}" ]]; then
  echo "ERROR: could not auto-detect the host IP. Pass it explicitly: ./set-server-ip.sh <ip>" >&2
  exit 1
fi
if ! [[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "ERROR: '$IP' does not look like an IPv4 address." >&2
  exit 1
fi

# --- resolve ports from .env (keep consistent with WEB_PORT/MINIO_PORT) ------
cur_pub="$(envget PUBLIC_BASE_URL)"
cur_turn="$(envget TURN_URL)"
# web port: explicit PORT > WEB_PORT > port in current PUBLIC_BASE_URL > 8080
PORT="${PORT:-}"
if [[ -z "$PORT" ]]; then PORT="$(envget WEB_PORT)"; fi
if [[ -z "$PORT" ]]; then PORT="$(printf '%s' "$cur_pub" | grep -oE ':[0-9]+' | tr -d ':' | head -1 || true)"; fi
PORT="${PORT:-8080}"
# TURN port: explicit TURN_PORT > port in current TURN_URL > 3478
TURN_PORT="${TURN_PORT:-}"
if [[ -z "$TURN_PORT" ]]; then TURN_PORT="$(printf '%s' "$cur_turn" | grep -oE ':[0-9]+' | tr -d ':' | tail -1 || true)"; fi
TURN_PORT="${TURN_PORT:-3478}"
# MinIO API port: MINIO_PORT in .env > 9000
MINIO_PORT="$(envget MINIO_PORT)"; MINIO_PORT="${MINIO_PORT:-9000}"

URL="http://${IP}:${PORT}"
TURN="turn:${IP}:${TURN_PORT}"
MINIO_URL="http://${IP}:${MINIO_PORT}"
echo ">> Target host IP: $IP"
echo ">>   web (PUBLIC_BASE_URL):    $URL"
echo ">>   TURN (TURN_URL):          $TURN"
echo ">>   MinIO (public endpoint):  $MINIO_URL"
echo

# --- 1. .env: PUBLIC_BASE_URL, TURN_URL, MINIO_PUBLIC_ENDPOINT ---------------
set_env PUBLIC_BASE_URL "$URL"
set_env TURN_URL "$TURN"
set_env MINIO_PUBLIC_ENDPOINT "$MINIO_URL"
echo ">> .env updated:"
echo "     $(grep '^PUBLIC_BASE_URL=' "$ENV_FILE")"
echo "     $(grep '^TURN_URL=' "$ENV_FILE")"
echo "     $(grep '^MINIO_PUBLIC_ENDPOINT=' "$ENV_FILE")"

# --- 2. enrollment_config (DB) ----------------------------------------------
echo ">> updating enrollment_config.server_base_url ..."
docker compose exec -T postgres psql -U mdm -d mdm -c \
  "UPDATE enrollment_config SET server_base_url='${URL}', updated_at=now();" >/dev/null
docker compose exec -T postgres psql -U mdm -d mdm -tAc \
  "SELECT 'db: '||server_base_url FROM enrollment_config;"

# --- 3. recreate the Go services so they pick up the new env -----------------
# notification-service is included so the new TURN_URL actually takes effect.
GO_SERVICES=(auth-service device-service policy-service command-service \
             telemetry-service notification-service file-service audit-service)
echo ">> recreating Go services ..."
docker compose up -d "${GO_SERVICES[@]}"

echo
echo "DONE. Server now advertises $URL (TURN at $TURN)."
echo "Next: on each phone open Dev Console → Set Server URL → ${IP}:${PORT}"
echo "      (re-enrollment is NOT required; tokens survive the repoint.)"
