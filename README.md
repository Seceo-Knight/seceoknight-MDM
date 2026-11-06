# SeceoKnight MDM

**Enterprise Mobile Device Management — by SeceoKnight Technologies**

Manage, monitor, and secure your entire Android fleet from one dashboard.
Full Device Owner control · Remote commands · Geofencing · Compliance · AI anomaly detection · OTA agent updates.

---

## Table of Contents

1. [What You Need](#1-what-you-need)
2. [Deploy the Server on Ubuntu](#2-deploy-the-server-on-ubuntu)
3. [First Login](#3-first-login)
4. [Build the Android Agent APK](#4-build-the-android-agent-apk)
5. [Get Your SHA-256 Checksum](#5-get-your-sha-256-checksum)
6. [Back Up Your Signing Keystore](#6-back-up-your-signing-keystore)
7. [Upload APK to the Portal](#7-upload-apk-to-the-portal)
8. [Configure Enrollment Settings](#8-configure-enrollment-settings)
9. [Enroll an Android Device](#9-enroll-an-android-device)
10. [Deploying to a New Client](#10-deploying-to-a-new-client)
11. [Pushing Agent Updates OTA](#11-pushing-agent-updates-ota)

---

## 1. What You Need

### For the server (at the client site)
| Item | Requirement |
|------|-------------|
| Machine | A PC, laptop, or mini PC that stays on 24/7 |
| OS | Ubuntu 22.04 LTS or newer |
| RAM | 4 GB minimum |
| CPU | 2 cores minimum |
| Disk | 40 GB free space |
| Network | Must be reachable by all Android devices (same LAN or public IP) |

> **Non-tech:** This is the "brain" computer. All managed phones talk to this machine. It can be a spare PC, a Raspberry Pi 5, a rented VPS, or even a mini PC at the office — as long as it stays on and is on the same network as the phones.

### For building the APK (your Mac — done once)
| Item | Requirement |
|------|-------------|
| Machine | Your Mac (any model with Apple Silicon or Intel) |
| Software | Docker Desktop (free) — [download here](https://www.docker.com/products/docker-desktop/) |

> **Non-tech:** You only need this to create the app file that gets installed on phones. You do this once on your own Mac, then upload the file to every client's server. No Android Studio or coding knowledge needed.

---

## 2. Deploy the Server on Ubuntu

Open a terminal on the Ubuntu machine and run these 3 commands one by one:

```bash
# Step 1 — Install Docker (the engine that runs everything)
curl -fsSL https://get.docker.com | sh

# Step 2 — Download the SeceoKnight MDM project
git clone https://github.com/Seceo-Knight/seceoknight-MDM
cd seceoknight-MDM

# Step 3 — Start everything
bash deploy.sh
```

The deploy script will:
- Detect the server's IP address automatically
- Create a configuration file (`.env`)
- Download and start all services (database, API server, admin dashboard, file storage)
- Run all database setup automatically

**How long does it take?**
- First deploy: 5–10 minutes (downloads ~2 GB of software packages)
- After that: under 1 minute

**How do I know it worked?**
When the terminal stops showing messages and you see the server IP printed, it is ready. You can also test by opening `http://<server-ip>` in a browser.

> **Non-tech:** Copy each of the 3 commands above and paste them into the black terminal window. Press Enter after each one and wait until it finishes before pasting the next. If you see red text — that is usually just warnings, not errors. Only worry if it says `Error` and stops.

---

## 3. First Login

Open any browser on any computer on the same network. Go to:

```
http://<your-server-ip>
```

For example: `http://192.168.1.62`

**Default login:**
| Field | Value |
|-------|-------|
| Email | `admin@mdm.local` |
| Password | `ChangeMe!123` |

> ⚠️ **Change the password right away.** Go to the top-right corner → your name → Profile → change password.

---

## 4. Build the Android Agent APK

> **This is done on your Mac — not on the client's server.**
> You build it once, save the file, and use the same file for every client deployment.

**Make sure Docker Desktop is open and running on your Mac first.**

Then open Terminal on your Mac and run:

```bash
cd ~/Downloads/seceoknight-MDM-main/android-agent
./build-apk.sh release
```

**First time:** Takes about 5 minutes. It downloads the Android build tools inside Docker.
**Every time after:** Under 1 minute (uses cached downloads).

**When it finishes you will see:**
```
✅ APK ready: app/build/outputs/apk/release/app-release.apk
```

Your APK file is at:
```
~/Downloads/seceoknight-MDM-main/android-agent/app/build/outputs/apk/release/app-release.apk
```

> **Non-tech:** This creates the `.apk` file — the actual Android app that gets installed on managed phones. Think of it like compiling the app. You do this once on your Mac, then upload the result to each client's server.

---

## 5. Get Your SHA-256 Checksum

The SHA-256 is a security code that Android uses to verify the app comes from SeceoKnight and hasn't been tampered with. You need this during enrollment setup.

**Run this on your Mac after the APK is built:**

```bash
keytool -printcert -jarfile \
  ~/Downloads/seceoknight-MDM-main/android-agent/app/build/outputs/apk/release/app-release.apk \
  | grep "SHA-256"
```

**You will see output like this:**
```
SHA-256: 3A:B2:FF:12:CD:...more characters...
```

**Copy and save the entire value** (the part after `SHA-256: `).

> **Important — read this:**
> This SHA-256 comes from your **signing keystore** (the secret key file), NOT from the APK content itself.
> This means: **every APK version you ever build will have the exact same SHA-256** — as long as you use the same keystore.
> So you only need to run this command once and save the value. You paste it into every client's enrollment config and never change it.

---

## 6. Back Up Your Signing Keystore

The signing keystore is a file automatically created during your first build:
```
~/Downloads/seceoknight-MDM-main/android-agent/.signing/debug.keystore
```

**This file is NOT saved in GitHub.** It only exists on your Mac right now.

**Back it up immediately — run on your Mac:**
```bash
cp ~/Downloads/seceoknight-MDM-main/android-agent/.signing/debug.keystore \
   ~/Desktop/seceoknight-signing-KEY-BACKUP.keystore
```

Then move `seceoknight-signing-KEY-BACKUP.keystore` from your Desktop to somewhere permanent and safe:
- iCloud Drive
- Google Drive
- USB drive stored in a safe place
- Your password manager (1Password, Bitwarden, etc.)

> ⚠️ **What happens if you lose this file:**
> - You can still build new APK versions BUT they will have a different signature
> - Every phone that already has the agent installed will **reject the new APK** with a "signature mismatch" error
> - To fix it you would have to factory-reset every single phone and re-enroll them from scratch
> - This could mean visiting 50+ client phones physically
>
> **Treat this file like a master password. Back it up once, never lose it.**

**To restore on a new Mac (if you get a new laptop):**
```bash
mkdir -p ~/Downloads/seceoknight-MDM-main/android-agent/.signing
cp /path/to/seceoknight-signing-KEY-BACKUP.keystore \
   ~/Downloads/seceoknight-MDM-main/android-agent/.signing/debug.keystore
```
Then run `build-apk.sh` as normal — it will use the restored keystore.

---

## 7. Upload APK to the Portal

> **This is done on the client's portal after the server is deployed.**

1. Open the admin portal in a browser (`http://<client-server-ip>`)
2. Log in and go to **Settings** (left sidebar, bottom)
3. Find the **Agent APK builds** section at the top of the Settings page
4. Click **Upload APK**
5. Select the APK file you built in Step 4:
   `app-release.apk`
6. Wait for the upload — it shows a green **Latest** badge when done

> **Where do you get the APK file on each new client?**
> The APK file is on **your Mac** (from Step 4). You can:
> - Copy it via USB drive
> - Upload it to Google Drive and download on the client machine
> - Upload it directly from your Mac's browser to the client's portal (if on the same network)
> - Best option: upload it to [GitHub Releases](https://github.com/Seceo-Knight/seceoknight-MDM/releases) once, then download from there on every client deployment

---

## 8. Configure Enrollment Settings

> **This is done in the client's portal.**

1. Go to **Enrollment** (left sidebar)
2. Scroll to the bottom of the page
3. Find **Provisioning configuration**
4. Fill in:

| Field | What to put |
|-------|-------------|
| **Server base URL** | `http://` + the client server's IP + `:8080` — e.g. `http://192.168.1.62:8080` |
| **APK download URL** | Leave **blank** (the system auto-uses your server's uploaded APK) |
| **Signing-cert SHA-256** | Paste the value you saved in Step 5 |
| **DPC package name** | `com.mdm.agent` |
| **Admin component** | `com.mdm.agent/com.mdm.core.admin.MDMDeviceAdminReceiver` |
| **WiFi SSID** | *(optional)* The WiFi name phones should connect to during setup |
| **WiFi password** | *(optional)* The WiFi password |

5. Click **Save**

> **Non-tech:** The Server base URL must be the IP of the Ubuntu machine at the client site, not `localhost` or your own Mac's IP. When a phone scans the QR code, it needs to reach this address.

---

## 9. Enroll an Android Device

> **Device Owner mode** means the MDM has full control — it can lock the screen, wipe the device, install and remove apps silently, enforce all restrictions. This requires the phone to be freshly factory-reset.

### Method A — QR Code (Recommended for new/reset devices)

**In the portal:**
1. Go to **Enrollment** (left sidebar)
2. From the dropdown, select **Device Owner (fully managed)**
3. Click **Generate token**
4. A QR code appears on screen — keep this window open

**On the Android phone:**
1. Factory-reset the phone:
   - Samsung: Settings → General management → Reset → Factory data reset
   - Other brands: Settings → System → Reset options → Erase all data
2. The phone restarts and shows a **Welcome screen** (language selection)
3. **Tap the center of the Welcome screen 6 times quickly** (this is a hidden Android feature for IT setup)
4. A QR scanner opens automatically
5. Point the phone camera at the QR code on your laptop/monitor
6. The phone automatically:
   - Connects to WiFi (if you configured it in Step 8)
   - Downloads the agent APK from your server
   - Installs it silently
   - Grants full Device Owner permissions
   - Enrolls itself into the portal
7. Within **30–60 seconds** the device appears in the portal under **Devices**

> **Non-tech:** The 6-tap trick works on all major Android brands (Samsung, Xiaomi, Realme, OnePlus, Motorola, etc.). The phone must show the first Welcome/language screen — if it has already been set up with apps and accounts, factory reset it first.

### Method B — ADB (Device already set up, no Google account)

Use this if the phone is already set up but has **no Google account** added to it.

```bash
# Connect the phone via USB cable to your Mac
# Enable USB Debugging on the phone first (Settings → Developer options → USB debugging)
adb install ~/Downloads/seceoknight-MDM-main/android-agent/app/build/outputs/apk/release/app-release.apk
adb shell dpm set-device-owner com.mdm.agent/com.mdm.core.admin.MDMDeviceAdminReceiver
```

Then open the agent app on the phone, tap **Configure manually**, enter:
- Server URL: `http://192.168.1.62:8080`
- Enrollment token: copy from the portal (Enrollment page → Generate token → token string)

> **Note:** If the phone has any Google account signed in, the ADB command will fail with "Not allowed". Factory reset first to remove accounts, or use Method A.

### Method C — Work Profile (BYOD personal phones)

Use this for personal employee phones where you want managed work apps without wiping the personal data.

**In the portal:**
1. Enrollment → select **Work Profile (BYOD)** → Generate token → QR appears

**On the employee's phone (no factory reset needed):**
1. Install the agent APK manually (send via link or USB)
2. Open the agent app → tap **Scan QR** → scan the QR from the portal
3. Android creates a separate encrypted work profile — personal photos, messages, apps are untouched

---

## 10. Deploying to a New Client

The same APK file works for **every client** — the server URL is passed through the QR code, not baked into the APK. Only the server changes per client.

### What you need each time
- Ubuntu machine at client site
- Your APK file (from Step 4 — same file every time)
- Your SHA-256 value (from Step 5 — same value every time)
- Your signing keystore backed up (from Step 6 — to rebuild APK later if needed)

### Steps

**On the client's Ubuntu server:**
```bash
curl -fsSL https://get.docker.com | sh
git clone https://github.com/Seceo-Knight/seceoknight-MDM
cd seceoknight-MDM
bash deploy.sh
```

**In the client's portal:**
1. Upload the APK → **Settings → Agent APK builds → Upload APK** (same APK file)
2. Set enrollment config → **Enrollment → Provisioning configuration**:
   - Server base URL: `http://<THIS-CLIENT-SERVER-IP>:8080`
   - Signing-cert SHA-256: same value you saved in Step 5
   - DPC package name: `com.mdm.agent`
   - Admin component: `com.mdm.agent/com.mdm.core.admin.MDMDeviceAdminReceiver`
3. Save → Generate QR → Enroll devices

> Every client gets a fresh database, their own devices, their own policies. Nothing is shared between clients.

---

## 11. Pushing Agent Updates OTA

When you release a new version of the agent:

**On your Mac:**
```bash
cd ~/Downloads/seceoknight-MDM-main/android-agent
./build-apk.sh release
```
*(Uses same keystore → same SHA-256 → no config changes needed)*

**In each client's portal:**
1. Settings → Agent APK builds → Upload the new APK
2. Go to Devices — phones on the old version show an amber **outdated** badge
3. Click **Update X outdated** in the Devices panel header
4. All phones download and install the new version silently and reconnect

---

## Service URLs

| Service | URL |
|---------|-----|
| MDM Dashboard | `http://<server-ip>` |
| Grafana (monitoring) | `http://<server-ip>:3001` |
| Traefik (routing/logs) | `http://<server-ip>:8081` |

---

## Updating the Server Software

When a new version of SeceoKnight MDM is released:

```bash
# On the Ubuntu server:
cd seceoknight-MDM
git pull
cd server && docker compose up -d --build
```

---

## Built by SeceoKnight Technologies
