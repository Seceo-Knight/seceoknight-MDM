# CyberSentinel MDM — Android Agent

**Vendor:** Virtual Galaxy Infotech Ltd

The on-device companion to the CyberSentinel MDM server. Built as a multi-module Gradle
project so the heavy DPM / MQTT machinery stays out of the UI module and is
trivially mockable in tests.

## Modules

| Module             | Purpose                                                                          |
|--------------------|----------------------------------------------------------------------------------|
| `:app`             | Compose UI, `MDMApplication`, `MainActivity`, `ProjectionRequestActivity` (transparent screen-capture consent) |
| `:mdm-core`        | `DevicePolicyController`, `MDMDeviceAdminReceiver`, `ProvisioningStash`          |
| `:networking`      | Retrofit + OkHttp (HTTP long-poll), paho MQTT (dormant), `AuthRepository`, `TokenStore`, per-request `BaseUrlInterceptor` |
| `:security`        | `CryptoManager`, `RootDetector`, `IntegrityChecker`                              |
| `:enrollment`      | `EnrollmentManager`, QR payload parsing, first-boot worker                       |
| `:policy-engine`   | `PolicySpec` (typed), `PolicyEngine`, `PolicyApplier` with diff-based reset      |
| `:command-executor`| `CommandService` (foreground, HTTP long-poll), `CommandExecutor`, `ActivityMonitor`, `KeepAliveAlarm`, `AppInstaller`, `AudioStreamManager` (segmented mic capture), `MessageActivity` (on-screen message popup), **`WebRtcScreenShareManager` + `ScreenRecorder` + `SignalingClient` + `RemoteControlService`** (live screen mirror) |
| `:telemetry`       | `TelemetryCollector`, `TelemetryWorker`                                          |

Dependency direction:

```
app → enrollment, policy-engine, command-executor, telemetry
              ↘            ↘             ↘
              mdm-core ── networking ── security
```

## Management modes

The agent runs whether or not it holds an admin role. `MainViewModel` no longer gates on admin — install + enroll alone reaches the home screen ("enrolled-only" mode). The home screen shows the current mode, optional elevation instructions, and a **Permissions panel** that requests the runtime permissions (camera/mic/location/notifications) and the Usage-Access special-access grant — essential in Device Admin / enrolled-only modes where nothing is auto-granted. The panel is **mode-aware**: Device-Owner-only grants (e.g. **Screen capture** / the accessibility service behind the live mirror) show only on a true Device Owner, while work-profile-only grants (install-unknown-apps, display-over-apps, location services) show only in a BYOD work profile — so a work profile is never asked to enable the screen-capture accessibility service it can't use. `CommandService` starts whenever enrolled (any mode), and reports the mode (`owner`/`admin`/`none`) on every heartbeat.

## What the agent does on the device

- **Foreground service** (`CommandService`) runs the **HTTP long-poll** command channel (`/commands/poll`, ~sub-second delivery) as the primary path; **MQTT is wired but dormant** (it was unreliable on OEM-frozen radios). A persistent wake lock + Doze-resistant `KeepAliveAlarm` (3-minute cadence) + 15-min WorkManager + `BOOT_COMPLETED`/`MY_PACKAGE_REPLACED` receivers recover an OS kill. The **heartbeat loop never stops trying to reach the server and its cadence is adaptive** — 60s once connected, but fast capped-backoff retries (3s→30s) the instant it can't reach the server, so a server that goes down and comes back (or a changed server IP) re-attaches within seconds, no user action needed. The `BaseUrlInterceptor` reads the configured server URL **per request**, so whatever IP is set in the app is always the one used. **`CommandService.reconnect()`** (wired to Dev Console **"Test & reconnect"**) hard-restarts the heartbeat/poll loops in-process so a stuck/frozen connection — e.g. after the server IP moves — recovers **without a phone reboot**. Its foreground-service **types are computed dynamically** — camera/mic/location/**mediaProjection** are declared only when in use (Android 14 rejects the FGS otherwise), so it doesn't crash in non-owner modes.
- **CommandExecutor** dispatches every server-side command kind: LOCK, WIPE, REBOOT (acks before rebooting so it can't loop), APPLY_POLICY, **CLEAR_POLICY** (rolls back camera-disable, all `UserRestriction`s, app + URL blocklists, surveillance toggles), INSTALL_APP / UNINSTALL_APP via PackageInstaller sessions, HIDE/SHOW/BLOCK/ALLOW app, CLEAR_APP_DATA, CAPTURE_PHOTO with lift-and-restore around `setCameraDisabled`, **START/STOP_AUDIO_STREAM**, **START/STOP_SCREEN_SHARE**, **WAKE_DEVICE** (remote power-button — turns the screen on so the live mirror survives a screen-off; Device Owner only), **SHOW_MESSAGE**, RESET_PASSWORD via the DO reset-password token machinery, GET_LOCATION, SET_VPN, SET_PROXY, etc.
- **WebRtcScreenShareManager** (Device Owner only) mirrors the screen live over WebRTC: `MediaProjection` → `ScreenCapturerAndroid` → hardware H.264 send-only track, ICE/SDP relayed via `SignalingClient` to the per-`(tenant,device)` `/ws/signal` room, NAT-traversed via the server's coturn. `RemoteControlService` (accessibility) auto-confirms the MediaProjection consent so capture starts silently; consent is locked to the whole screen via `MediaProjectionConfig.createConfigForDefaultDisplay()`, the screen is woken for the consent, encoder output is halved (`scaleResolutionDownBy`) for low latency, and a session wake lock keeps the display rendering. Recording is done browser-side; `ScreenRecorder` (device-side MP4 tap) remains as a fallback. **Remote control (Phase 2):** the manager opens a `control` `RTCDataChannel`; the admin browser sends normalized `{tap,swipe,key,text}` events, which `RemoteControlService` replays as real input via `dispatchGesture` (tap/swipe), `performGlobalAction` (home/back/recents), and `setText` (focused field). The browser offers two modes — **Share screen** (view-only) and **Control**.
- **WakeActivity** (`WAKE_DEVICE`, Device Owner only) is the remote power-button. MediaProjection only captures while the display is rendering, so when the screen turns off the mirror goes black and the session drops; the Screen tab's **Wake** button issues `WAKE_DEVICE`, which launches this transparent activity to turn the screen on (`setTurnScreenOn`/`setShowWhenLocked` + a brief `ACQUIRE_CAUSES_WAKEUP` wake lock — the modern, reliable path from a fully-off/locked state). Both the command handler and the activity refuse non-Device-Owner enrollments, mirroring `ProjectionRequestActivity`.
- **AudioStreamManager** records the mic as short AAC/**ADTS** segments (byte-concatenable, so the server can stitch a session into one file), uploading each as it finishes. `start()` awaits and reports the first segment's outcome so a silent mic/permission/upload failure surfaces in the command result instead of recording into the void.
- **MessageActivity** shows an admin-pushed message as a dialog (show-when-locked + turn-screen-on); the command also raises a high-priority full-screen-intent notification so the message lands across all modes.
- **ActivityMonitor** registers broadcast receivers for screen on/off, USER_PRESENT, power, connectivity, package events, and a 3 s `UsageStatsManager.queryEvents` poll for per-app foreground tracking. Every event ships as a telemetry row for the admin's Activity tab. On the first detection of a missing `PACKAGE_USAGE_STATS` grant it auto-opens the Settings page and posts a sticky notification — that op is signature-protected so even a Device Owner cannot programmatically grant it.
- **PolicyEngine + PolicyApplier**: fetches the merged effective policy from the server, decodes via kotlinx-serialization (`ignoreUnknownKeys=true`), and reflects it onto the device. Persists the last-applied spec to TokenStore so the next apply can diff: any field set previously but absent now gets explicitly reset (otherwise null-means-preserve strands the device in the prior state after unassign).
- **Surveillance**: `capture_on_unlock` policy snaps the front camera on every USER_PRESENT and uploads via the device-authenticated file endpoint.

## Build

```bash
cd android-agent
./build-apk.sh             # debug APK (Docker-based; no host JDK required)
# or
./gradlew :app:assembleDebug
```

Output: `app/build/outputs/apk/debug/app-debug.apk`.

## Provisioning

Two paths:

1. **QR / `afw#` enrollment**: factory reset, scan the QR generated by the
   admin console. Setup Wizard hands off to
   `MDMDeviceAdminReceiver.onProfileProvisioningComplete`, which stashes the
   token in `ProvisioningStash` and starts `CommandService`.

2. **adb (dev only)** — pick the mode you want:
   ```bash
   adb install -r app/build/outputs/apk/debug/app-debug.apk
   # Device Owner (full control; device must be freshly reset / no accounts):
   adb shell dpm set-device-owner   com.mdm.agent/com.mdm.core.admin.MDMDeviceAdminReceiver
   # …or Device Admin (subset; no reset needed):
   adb shell dpm set-active-admin   com.mdm.agent/com.mdm.core.admin.MDMDeviceAdminReceiver
   # …or neither — just launch the app and enroll for read-only "enrolled-only" mode.
   ```
   Then launch the app, enter the server URL / token, and use the Permissions panel to grant what the active mode needs.

On first launch the agent auto-launches Usage Access settings + posts a notification so the user can grant `PACKAGE_USAGE_STATS` with one tap. Until granted, every other activity stream still flows; only the per-app foreground tracking is gated.

## Testing

Unit tests live under each module's `src/test`. CI runs them via:

```bash
./gradlew test
```
