# Changelog

All notable changes to the **CyberSentinel MDM Android agent** — APK `versionName`,
tracked in [`android-agent/version.properties`](android-agent/version.properties) —
are recorded here, newest first. Server / admin-web changes are noted against the
agent version they shipped alongside.

> **Scope note.** `build-apk.sh` bumps `versionPatch` on every build, so there are
> many more patch numbers than there are user-facing changes. This log captures the
> versions that carried a real change. Per-version detail is reliable from **v1.0.37**
> onward (the live screen-mirror work); earlier releases predate granular tracking and
> are summarized as **repository milestones** (git history) at the bottom.
>
> Dates are approximate where not precisely recorded. **Going forward, every agent
> version bump should add an entry here.**

---

## [1.0.56] — 2026-06-29
### Fixed
- **The agent could get permanently stuck "Disconnected" after a long outage —
  the real root cause behind v1.0.55.** The adaptive heartbeat (1.0.55) fixed the
  *cadence* but not the *lockup*. Two defects in the token-refresh path froze the
  agent whenever `/auth/refresh` returned **HTTP 401** (refresh token expired past
  `JWT_REFRESH_TTL`, **or the server DB was reset/redeployed** — common in dev):
  1. **Authenticator deadlock.** `TokenAuthenticator` reacted to the 401 on the
     refresh call *itself* by re-entering `refreshNow()`, which blocked forever
     trying to re-acquire the single-flight `Mutex` the outer refresh already held
     (that refresh can't return until the authenticator does — classic deadlock).
     The heartbeat coroutine parked indefinitely and the device never recovered.
     **Fix:** the authenticator now ignores 401s on the `/auth/refresh` and
     `/enroll` entry points (mirrors `TokenInterceptor.isUnauthRoute`).
  2. **De-enroll on the first transient 401.** A single refresh 401 wiped the
     device's credentials, so a recoverable blip (server mid-redeploy, DB restore,
     JWT-secret rotation) stranded it with no way back. **Fix:** credentials are
     now only cleared after refresh has been rejected **continuously for 15 min**
     (`REENROLL_GRACE_S`); any successful refresh resets the streak. A transient
     rejection just keeps retrying and re-attaches the moment the server returns.
- **Call-timeout backstop.** The agent's API OkHttp client now sets
  `callTimeout(60s)` (safely above the 20 s long-poll), so no single request can
  ever wedge the heartbeat/poll loop indefinitely again.

### Server / infra (shipped alongside)
- **Configurable ports + env-driven super-admin (nothing hardcoded).** The whole
  setup's access port is now `WEB_PORT` (default `8080`) in `server/.env`; every
  other published host port (`POSTGRES_PORT`, `GRAFANA_PORT`, `MINIO_PORT`, …) is
  likewise an env var defaulting to its current value. The initial super-admin is
  set from `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` — the hardcoded bcrypt hash
  was removed from `009_seed.sql`; a new env-driven `010_seed_superadmin.sh`
  hashes the password at seed time via Postgres `pgcrypto` (bcrypt cost 12,
  verified compatible with the Go service's `golang.org/x/crypto/bcrypt`). Docs
  updated (`server/README.md`, root `README.md`, `SETUP.md`, `.env.example`).

---

## [1.0.55] — 2026-06-29
### Fixed
- **The agent now never stops trying to reach the server.** Previously the heartbeat
  loop — the only thing that drives the "Connected" indicator and proves the device is
  reaching the server — slept a **fixed 60 s between every attempt**, so a server that
  went down and came back (or a changed server IP) could sit "Disconnected" for up to a
  full minute and looked like it had given up. The heartbeat cadence is now **adaptive**:
  60 s once connected, but **fast capped-backoff retries (3 s → 6 s → … → 30 s max)** the
  instant it can't reach the server. The loop only ever delays, never exits, so it
  re-attaches within seconds of the server returning — no user action needed.
- Reaffirmed that `BaseUrlInterceptor` reads the configured server URL **per request**,
  so whatever IP is set in the app is always the one used; documented in the agent README.

---

## [1.0.54] — 2026-06-29
### Added
- **`WAKE_DEVICE` — remote power-button (Device Owner only).** MediaProjection only
  captures a *rendering* display, so when the phone screen turns off the live mirror goes
  black and the WebRTC session dies. A new **Wake** button on the admin Screen tab issues
  `WAKE_DEVICE`, which launches a transparent **`WakeActivity`**
  (`setShowWhenLocked`/`setTurnScreenOn` + `FLAG_TURN_SCREEN_ON|SHOW_WHEN_LOCKED|KEEP_SCREEN_ON`
  + a brief `SCREEN_BRIGHT_WAKE_LOCK|ACQUIRE_CAUSES_WAKEUP` wake lock) to turn the screen
  on and revive the feed. Tiered as a **surveillance** command (same as screen share);
  both the command handler and the activity refuse non-Device-Owner enrollments.
- End-to-end wiring: server `commands.go` (`KindWakeDevice` + `Valid` map), `shared/authz`
  command tier, agent `CommandKind` + `CommandExecutor` handler, admin-web `ScreenTab.tsx`
  Wake button + `lib/rbac.ts` client mirror.

---

## [1.0.53] — 2026-06-29
### Fixed
- **Work-profile (BYOD) devices no longer ask for the screen-capture accessibility
  permission.** `HomeScreen` intentionally passes a Profile Owner into `PermissionsPanel`
  as `deviceOwner = true` (to suppress runtime-grant prompts the profile auto-grants), so
  the Device-Owner-only "Screen capture" row + "Enable accessibility" button leaked into
  work profiles. Fixed by deriving `trueDeviceOwner = deviceOwner && !workProfile` and
  gating the screen-capture row, the accessibility button, and the `screenCaptureOk` check
  on it. Real Device Owner is unchanged; a work profile now hides the row entirely.

---

## [1.0.52] — 2026-06-29
### Fixed
- **Hardened the owner-only guard so a work profile can never surface the MediaProjection
  consent.** `ProjectionRequestActivity.onCreate` now injects `DevicePolicyController` and,
  if `!isDeviceOwner()`, clears `screenSharing` and `finish()`es **before**
  `createScreenCaptureIntent()`. Defense-in-depth on top of the existing
  `START_SCREEN_SHARE` owner-guard — a non-DO device can no longer show the prompt no
  matter how a command is misrouted.

---

## [1.0.51] — 2026-06-26
### Fixed
- **Remote-control taps landed slightly above the touch point (worse toward the bottom).**
  `RemoteControlService` scaled normalized `[0,1]` coordinates by
  `resources.displayMetrics`, which excludes the nav/status bars on many OEMs. Switched to
  the real physical display size (`WindowManager.maximumWindowMetrics.bounds`, with a
  `getRealMetrics` fallback) — the same space MediaProjection captures and `dispatchGesture`
  addresses — so taps now land exactly.

---

## [1.0.50] — 2026-06-26
### Added
- **Screen mirror Phase 2 — remote control of the device from the browser.** The agent
  opens a `control` `RTCDataChannel`; the admin browser sends normalized `{tap,swipe,key,text}`
  events that `RemoteControlService` replays as real input via `dispatchGesture` (tap/swipe),
  `performGlobalAction` (Home/Back/Recents), and `setText` (focused field). The Screen tab
  offers two modes — **Share screen** (view-only) and **Control** — with a Back/Home/Recents
  toolbar. Reuses the surveillance permission (no separate capability added).

---

## [1.0.49] — 2026-06-24
### Added
- **"Test & reconnect" now hard-restarts the agent's networking in-process.**
  `CommandService.reconnect()` cancels and re-wires the heartbeat/poll loops (re-reading the
  current server URL) and punches an immediate heartbeat, so a stuck/frozen connection — e.g.
  after the server IP moves — recovers **without a phone reboot**. `applyServerConfig` now
  calls this instead of a soft tick (which was a no-op for re-wiring).

---

## [1.0.48] — 2026-06-24
### Changed
- **Stable screen-mirror build.** Encoder-side downscale (`scaleResolutionDownBy = 2.0`,
  max 2.5 Mbps / 30 fps) for smooth low-latency mirroring without ever resizing the capture
  (which tears down the projection); screen-off wake during a session
  (`setTurnScreenOn`/`setShowWhenLocked` + `SCREEN_BRIGHT_WAKE_LOCK`); `screendiag`
  breadcrumb telemetry. **Hard rule established: never resize / `changeCaptureFormat` the
  capture mid-session — it drops the WebRTC peer.** Rotation is an accepted cosmetic
  limitation (landscape is letterboxed); a later browser-side heuristic crops the bars.
- Admin-web: full recording UI — save (with `device_id`), Play/Close, Download, Delete.

### Reverted
- **v1.0.47** rotation attempt (`changeCaptureFormat` on rotation re-inits the encoder and
  dropped the peer) and **v1.0.45** lag attempt (`adaptOutputFormat` crops instead of
  letterboxing) were both reverted into this stable build.

---

## [1.0.46] — 2026-06-24
### Fixed
- **Screen-mirror lag.** Replaced the bad `adaptOutputFormat` downscale with encoder-side
  `scaleResolutionDownBy = 2.0` (halves each dimension preserving aspect, follows rotation,
  never touches the projection). Added a Close button and per-recording Delete in admin-web.

---

## [1.0.44] — 2026-06-24
### Fixed
- **Screen recordings never saved.** The Postgres `file_objects_kind_check` constraint
  didn't allow `screen`, so every upload 500'd. Added **migration
  `019_files_screen_kind.sql`** (adds `screen` + `screendiag`) and applied it live.
### Added
- Diagnostic `screendiag` breadcrumb to trace why MediaProjection was being stopped by the
  system (`startCapture → onStop` timing).

---

## [1.0.42] — 2026-06-24
### Fixed
- **`REBOOT` command reboot-loop.** The agent ran `rebootDevice()` before posting the
  result, so the command stayed `dispatched` and the server re-delivered it on every boot.
  Now the agent **acks `REBOOT` before rebooting** (mirroring the INSTALL_APP self-update
  pre-ack).

---

## [1.0.41] — 2026-06-24
### Changed
- **Recording moved to the browser.** The device-side `ScreenRecorder` produced empty files
  on the test phone and ran a second on-device encoder. The viewer now records the received
  stream (`MediaRecorder`, webm) and uploads it (`kind="screen"`); `ScreenRecorder` remains
  as a fallback.
- **Latency:** browser sets `jitterBufferTarget = 0`; the device no longer runs a second
  encoder. **Landscape:** `<video>` uses `object-contain` so it fills width instead of being
  clipped.

---

## [1.0.38] — 2026-06-24
### Fixed
- **Silent screen capture works end-to-end.** On Android 14+ the MediaProjection picker
  defaulted to "a single app," which the headless auto-confirm couldn't complete. Using
  `createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())` removes
  the picker and locks consent to the entire screen, leaving a single "Start" the
  accessibility service taps. Added the "Screen capture" accessibility row to the agent
  `PermissionsPanel` (Device-Owner only) and a browser keepalive ping to avoid idle-socket
  1006 drops.

---

## [1.0.37] — 2026-06-24
### Added
- **Live screen mirror (WebRTC), Device Owner only — first hardened build.**
  `WebRtcScreenShareManager` (MediaProjection → `ScreenCapturerAndroid` → H.264) with
  `START/STOP_SCREEN_SHARE` (surveillance tier), notification-service `/ws/signal` relay per
  `(tenant,device)`, HMAC short-lived TURN creds via coturn, and the admin **Screen tab**.
  `RemoteControlService` (accessibility) auto-confirms the consent dialog (clicks
  `android:id/button1` by view-id + `flagReportViewIds`).

> Several experimental builds between these versions (**1.0.39–1.0.40**, **1.0.43**,
> **1.0.45**, **1.0.47**) were diagnostic or were reverted — see the surrounding entries.

---

## Repository milestones (git history)

Earlier work predates per-APK-version tracking; these are the repository's git milestones,
listed by commit so nothing is invented.

- **2026-06-26** — Added remote-access feature (screen-mirror Phase 2 / remote control era).
- **2026-06-24** — Refactored the platform to run on plain **HTTP long-poll instead of MQTT**
  (MQTT retained but dormant) and added the screen-share feature; updated the Markdown docs
  for the new architecture.
- **2026-06-17** — Fixed server-side manual app update; added the in-app **config panel**.
- **2026-06-15** — Added **agent self-update** and **battery-optimization** handling
  (Doze/keep-alive); APK + server UI refresh.
- **2026-06-03** — Fixed CI; UI enhancements.
- **2026-06-02** — Enhanced UI; added **Time-Travel** device snapshots.
- **2026-06-01** — Added basic device features: **camera, microphone, and enrollment modes**
  (Device Owner / Profile Owner / Device Admin / enrolled-only).
- **2026-05-20** — Tool updated to **V2** with added features.
- **2026-05-13** — Initial commit: CyberSentinel MDM platform.
