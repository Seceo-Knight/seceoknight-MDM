#!/usr/bin/env bash
# build-apk.sh — builds the SeceoKnight MDM agent APK inside a slim
# containerised Android SDK + JDK 17. The host only needs Docker.
#
# Usage:
#   ./build-apk.sh           # debug APK (default)
#   ./build-apk.sh release   # release APK
#
# First run builds the local builder image (~1.3 GB) and downloads Gradle
# deps (~500 MB) — total ~5 min on a fast link. Subsequent runs reuse both
# caches and finish in well under a minute.

set -euo pipefail
cd "$(dirname "$0")"

IMAGE_TAG="seceoknight-android-builder:latest"
VARIANT="${1:-debug}"
# Capitalise first letter without bash4 ${^} (works on macOS default bash3)
VARIANT_CAP="$(echo "${VARIANT:0:1}" | tr '[:lower:]' '[:upper:]')${VARIANT:1}"
TASK="assemble${VARIANT_CAP}"   # assembleDebug / assembleRelease

# Step 1: build the slim builder image if absent (or if the Dockerfile changed).
if ! docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
    echo "🧱  Building local Android builder image ($IMAGE_TAG)…"
    docker build --platform linux/amd64 -t "$IMAGE_TAG" ./builder
fi

# Step 2: persistent Gradle cache so dependency downloads happen once.
docker volume create mdm-gradle-cache >/dev/null 2>&1 || true

# Step 2b: stable debug signing key. Without this, each --rm build generates a
# fresh ~/.android/debug.keystore inside the container, so the APK's signing
# cert (and therefore its PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM) changes
# every build — which also blocks `adb install -r` updates (signature mismatch)
# and forces a factory-reset re-provision for every code change. We keep one
# keystore under ./.signing and mount it at the container's ~/.android so the
# default Gradle debug signingConfig reuses it. Uses the canonical AOSP debug
# credentials (alias androiddebugkey, storepass/keypass "android").
SIGN_DIR="$PWD/.signing"
if [ ! -f "$SIGN_DIR/debug.keystore" ]; then
    echo "🔑  Generating stable debug keystore (one-time) at .signing/debug.keystore…"
    mkdir -p "$SIGN_DIR"
    docker run --rm --platform linux/amd64 -v "$SIGN_DIR:/ks" "$IMAGE_TAG" bash -lc "
        keytool -genkeypair -v -keystore /ks/debug.keystore \
          -storepass android -keypass android -alias androiddebugkey \
          -keyalg RSA -keysize 2048 -validity 10000 \
          -dname 'CN=Android Debug,O=Android,C=US'"
fi

# Step 2c: bump the human version so every build advances 1.0.0 → 1.0.1 → …
# (read by app/build.gradle.kts for versionName), not just the auto build number.
VERF="$PWD/version.properties"
if [ -f "$VERF" ]; then
    cur=$(grep -E '^versionPatch=' "$VERF" | cut -d= -f2)
    next=$(( ${cur:-0} + 1 ))
    tmp=$(mktemp)
    sed "s/^versionPatch=.*/versionPatch=$next/" "$VERF" > "$tmp" && mv "$tmp" "$VERF"
    echo "🔢  Agent version → $(grep '^versionMajor=' "$VERF" | cut -d= -f2).$(grep '^versionMinor=' "$VERF" | cut -d= -f2).$next"
fi

echo "🛠  Building SeceoKnight MDM agent ($VARIANT)…"
docker run --rm --platform linux/amd64 \
  -v "$PWD:/project" \
  -v mdm-gradle-cache:/root/.gradle \
  -v "$SIGN_DIR:/root/.android" \
  -w /project \
  -e GRADLE_USER_HOME=/root/.gradle \
  -e JAVA_TOOL_OPTIONS=-Xmx3g \
  "$IMAGE_TAG" \
  bash -lc "
    set -e
    if [ ! -x ./gradlew ]; then
      echo '→ generating gradle wrapper (gradle 8.7)'
      gradle wrapper --gradle-version 8.7 --distribution-type bin 2>/dev/null || {
        echo '→ no system gradle; bootstrapping wrapper from network'
        curl -sSL https://services.gradle.org/distributions/gradle-8.7-bin.zip -o /tmp/g.zip
        unzip -q /tmp/g.zip -d /opt
        /opt/gradle-8.7/bin/gradle wrapper --gradle-version 8.7 --distribution-type bin
        rm /tmp/g.zip
      }
    fi
    ./gradlew :app:$TASK --no-daemon --console=plain --stacktrace
  "

APK="app/build/outputs/apk/${VARIANT}/app-${VARIANT}.apk"
if [ -f "$APK" ]; then
  echo
  echo "✅ APK ready: $(realpath "$APK")"
  ls -lh "$APK"
  echo
  echo "Install on a connected phone with:"
  echo "  adb install -r '$APK'"
  echo "Set Device Owner (must be the only user; factory-reset first if needed):"
  echo "  adb shell dpm set-device-owner com.mdm.agent/com.mdm.core.admin.MDMDeviceAdminReceiver"
else
  echo "❌ APK not produced; check the build log above"
  exit 1
fi
