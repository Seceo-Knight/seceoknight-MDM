# SeceoKnight MDM

**Enterprise Mobile Device Management — built by SeceoKnight Technologies**

Manage, monitor, and secure your entire Android fleet from a single dashboard. Full Device Owner control, remote commands, geofencing, compliance rules, AI anomaly detection, and OTA agent updates.

---

## Table of Contents

1. [Server Requirements](#1-server-requirements)
2. [Deploy the Server](#2-deploy-the-server)
3. [First Login](#3-first-login)
4. [Build the Android Agent APK](#4-build-the-android-agent-apk)
5. [Get Your SHA-256 Checksum](#5-get-your-sha-256-checksum)
6. [Back Up Your Signing Keystore](#6-back-up-your-signing-keystore)
7. [Upload APK to the Portal](#7-upload-apk-to-the-portal)
8. [Configure Enrollment Settings](#8-configure-enrollment-settings)
9. [Enroll an Android Device](#9-enroll-an-android-device)
10. [Deploying to a New Client](#10-deploying-to-a-new-client)

---

## 1. Server Requirements

| Item | Minimum |
|------|---------|
| OS | Ubuntu 22.04 LTS or newer |
| RAM | 4 GB |
| CPU | 2 cores |
| Disk | 40 GB |
| Network | Static LAN IP or domain name |

> **Non-tech note:** This is a computer (or VM) that stays on 24/7 and acts as the brain of the MDM system. All managed phones talk to this server.

---

## 2. Deploy the Server

Open a terminal on the Ubuntu machine and run these 3 commands:

```bash
# 1. Install Docker (skip if already installed)
curl -fsSL https://get.docker.com | sh

# 2. Clone the project
git clone https://github.com/Seceo-Knight/seceoknight-MDM
cd seceoknight-MDM

# 3. Deploy everything
bash deploy.sh
```

The deploy script automatically:
- Detects the server's IP address
- Creates the `.env` configuration file
- Starts all services (database, API, dashboard, file storage)
- Runs database migrations

**First deploy takes about 3–5 minutes.** You will see logs scrolling — this is normal. When it stops and you see `✅ SeceoKnight MDM is running`, it is ready.

> **Non-tech note:** Copy and paste these 3 commands one by one into the black terminal window. Press Enter after each one and wait for it to finish before running the next.

---

## 3. First Login

Open a browser on any computer on the same network and go to:

```
http://<your-server-ip>
```

Replace `<your-server-ip>` with the actual IP of your Ubuntu machine (e.g. `http://192.168.1.62`).

**Default login credentials:**
| Field | Value |
|-------|-------|
| Email | `admin@mdm.local` |
| Password | `ChangeMe!123` |

> ⚠️ **Change the password immediately** after first login — go to your Profile (top right corner).

---

## 4. Build the Android Agent APK

The Android agent is the app that gets installed on managed phones. You only need to build it **once** (and again only when you release a new version).

**Requirements on your Mac:**
- Docker Desktop must be installed and running
- That's it — no Android Studio, no Java, no SDK needed

**Run the build:**

```bash
cd seceoknight-MDM/android-agent
./build-apk.sh release
```

**First run:** Downloads the Android build environment inside Docker (~5 minutes, one-time only).

**Subsequent runs:** Under 60 seconds (everything is cached).

When finished you will see:
```
✅ APK ready: android-agent/app/build/outputs/apk/release/app-release.apk
```

> **Non-tech note:** This creates the actual app file (`.apk`) that will be installed on Android phones. Think of it like compiling the app.

---

## 5. Get Your SHA-256 Checksum

The SHA-256 checksum proves the APK was signed by SeceoKnight and not tampered with. Android requires this during the QR enrollment process.

Run this command **after** building the APK:

```bash
keytool -printcert -jarfile \
  seceoknight-MDM/android-agent/app/build/outputs/apk/release/app-release.apk \
  | grep "SHA-256"
```

You will see something like:
```
SHA-256: AB:12:CD:34:EF:...
```

**Save this value** — you will paste it into the enrollment config in Step 8.

> **Important:** This value comes from your signing key (not the APK file itself), so it is **identical for every version you ever build** as long as you use the same keystore. You only need to run this once and save the result.

---

## 6. Back Up Your Signing Keystore

The signing keystore is a file created automatically during your first build:

```
seceoknight-MDM/android-agent/.signing/debug.keystore
```

**This file is NOT in the GitHub repo** (it is intentionally excluded for security). It only exists on the machine where you ran the build.

**Back it up immediately:**

```bash
# Copy to Desktop first
cp seceoknight-MDM/android-agent/.signing/debug.keystore \
   ~/Desktop/seceoknight-signing.keystore
```

Then move `seceoknight-signing.keystore` to a safe permanent location:
- iCloud Drive / Google Drive
- A USB drive stored securely
- Your company's password manager

> ⚠️ **If you lose this file:**
> - New APK builds will have a different signature
> - Existing enrolled devices will **reject OTA updates** (signature mismatch)
> - You will have to factory-reset every managed phone and re-enroll them
>
> Treat this file like a password — back it up once, store it safely, never share it publicly.

**To restore on a new machine:**
```bash
mkdir -p seceoknight-MDM/android-agent/.signing
cp /path/to/seceoknight-signing.keystore \
   seceoknight-MDM/android-agent/.signing/debug.keystore
```

Then run `build-apk.sh` as normal — it will reuse the restored keystore.

---

## 7. Upload APK to the Portal

1. Open the admin portal in your browser
2. Go to **Settings** (left sidebar, bottom)
3. Find the **Agent APK builds** section at the top
4. Click **Upload APK**
5. Select the file: `android-agent/app/build/outputs/apk/release/app-release.apk`
6. Wait for the upload to complete — you will see it listed with a **Latest** badge

> **Non-tech note:** This stores the APK on your server so Android phones can download it automatically during enrollment.

---

## 8. Configure Enrollment Settings

1. Go to **Enrollment** in the left sidebar
2. Scroll to the bottom — find **Provisioning configuration**
3. Fill in the following fields:

| Field | Value |
|-------|-------|
| Server base URL | `http://192.168.1.62:8080` *(your server's IP)* |
| APK download URL | Leave **blank** *(auto-uses your server)* |
| Signing-cert SHA-256 | Paste the value from Step 5 |
| DPC package name | `com.mdm.agent` |
| Admin component | `com.mdm.agent/com.mdm.core.admin.MDMDeviceAdminReceiver` |

4. Click **Save**

> **Non-tech note:** This tells the system where the server lives and which app to install on phones. The server base URL must be the IP address of your Ubuntu server, not `localhost`.

---

## 9. Enroll an Android Device

> **What "Device Owner" means:** The MDM gets full control — it can lock the screen, wipe the device, install/remove apps silently, enforce restrictions, and push configurations. This is the highest level of management and requires a factory-reset device.

### Method A — QR Code (Recommended)

**In the portal:**
1. Go to **Enrollment**
2. Select **Device Owner (fully managed)** from the dropdown
3. Click **Generate token**
4. A QR code appears — keep this screen open

**On the Android phone:**
1. Factory-reset the phone (Settings → General management → Reset → Factory data reset)
2. When the phone restarts and shows the **Welcome / language selection** screen, **tap the center of the screen 6 times quickly**
3. A QR scanner opens automatically
4. Point the phone's camera at the QR code on your laptop screen
5. The phone downloads the agent app, installs it, and enrolls itself automatically
6. Within 30–60 seconds the device appears in the portal under **Devices**

> **Non-tech note:** The 6-tap trick is a hidden feature built into Android for IT setup. It works on all major brands (Samsung, Xiaomi, OnePlus, Motorola, etc.). The phone must be on a fresh factory reset — if it already has apps/accounts on it, use Method B below.

### Method B — ADB (Already set-up device, no Google account)

If the device is already set up but has **no Google account** added:

```bash
# Connect phone via USB with USB debugging enabled, then:
adb shell dpm set-device-owner \
  com.mdm.agent/com.mdm.core.admin.MDMDeviceAdminReceiver
```

Then open the agent app on the phone, enter the server URL and enrollment token from the portal.

> **Note:** This fails if any Google account is on the device. Factory reset first if needed.

### Method C — Work Profile (BYOD — personal phones)

For personal employee phones where you want a managed work container without full device control:

1. In the portal → Enrollment → select **Work Profile (BYOD)**
2. Generate token → QR appears
3. On the employee's phone (no factory reset needed): open the agent app → tap **Scan QR** → scan the code
4. A separate encrypted work profile is created — personal data is untouched

---

## 10. Deploying to a New Client

Each client gets their own server. The same APK works for every client — only the server IP changes.

**What you need per client:**
- An Ubuntu machine at the client site (or a VM/cloud server)
- The same APK file (from your GitHub Releases or built once)
- Your signing keystore (from Step 6)

**Steps:**

```bash
# 1. On the client's Ubuntu machine — same 3 commands as Step 2
curl -fsSL https://get.docker.com | sh
git clone https://github.com/Seceo-Knight/seceoknight-MDM
cd seceoknight-MDM && bash deploy.sh
```

Then in the client's portal:
1. Upload the APK (same file — Step 7)
2. Set **Server base URL** to the client's server IP (Step 8)
3. Paste the **same SHA-256** checksum you saved in Step 5
4. Save → Generate QR → Enroll devices

> The APK binary is identical for every client. Only the server URL in the QR code is different. The SHA-256 never changes as long as you use the same keystore.

---

## Service URLs

| Service | URL |
|---------|-----|
| MDM Dashboard | `http://<server-ip>` |
| Grafana (monitoring) | `http://<server-ip>:3001` |
| Traefik (routing) | `http://<server-ip>:8081` |

---

## Updating the Server

When a new version is released, run on the server:

```bash
cd seceoknight-MDM
git pull
cd server && docker compose up -d --build
```

---

## Updating the Agent APK (OTA)

When you release a new agent version:

1. Run `./build-apk.sh release` on your Mac (uses the same keystore — same SHA-256)
2. Upload the new APK in **Settings → Agent APK builds**
3. Go to **Devices** — outdated devices show an amber **outdated** badge
4. Click **Update X outdated** — all devices silently install the new version and reconnect

---

## Support

Built and maintained by **SeceoKnight Technologies**.
