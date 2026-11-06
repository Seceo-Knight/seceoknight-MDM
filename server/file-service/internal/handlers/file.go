package handlers

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/rs/zerolog/log"

	"github.com/mdm/file-service/internal/repository"
	"github.com/mdm/file-service/internal/storage"
	"github.com/mdm/shared/middleware"
	"github.com/mdm/shared/models"
)

type Handler struct {
	repo  *repository.FileRepo
	store *storage.Storage
}

func New(r *repository.FileRepo, s *storage.Storage) *Handler { return &Handler{repo: r, store: s} }

// Upload streams a multipart file into MinIO and records metadata. Admin path —
// the uploader is the authenticated user.
func (h *Handler) Upload(c *fiber.Ctx) error {
	return h.upload(c, false)
}

// DeviceUpload is the device-authenticated counterpart used for camera
// captures and log bundles. Files are tied to the calling device's id.
func (h *Handler) DeviceUpload(c *fiber.Ctx) error {
	return h.upload(c, true)
}

func (h *Handler) upload(c *fiber.Ctx, byDevice bool) error {
	mf, err := c.FormFile("file")
	if err != nil {
		log.Warn().Err(err).Msg("upload: FormFile parse failed")
		return c.Status(400).JSON(fiber.Map{"error": "file form field required: " + err.Error()})
	}
	kind := c.FormValue("kind", "generic")
	name := c.FormValue("name", mf.Filename)
	tenantID := tenantOf(c)

	f, err := mf.Open()
	if err != nil {
		log.Error().Err(err).Msg("upload: form open failed")
		return c.Status(500).JSON(fiber.Map{"error": "open form: " + err.Error()})
	}
	defer f.Close()

	h1 := sha256.New()
	pr, pw := io.Pipe()
	errCh := make(chan error, 1)
	go func() {
		defer pw.Close()
		_, err := io.Copy(io.MultiWriter(h1, pw), f)
		errCh <- err
	}()

	storageKey := fmt.Sprintf("%s/%s/%s", kind, tenantID, uuid.NewString())
	if err := h.store.Put(c.Context(), storageKey, pr, mf.Size, mf.Header.Get("Content-Type")); err != nil {
		log.Error().Err(err).Str("key", storageKey).Int64("size", mf.Size).Msg("upload: MinIO Put failed")
		return c.Status(500).JSON(fiber.Map{"error": "store: " + err.Error()})
	}
	if err := <-errCh; err != nil {
		log.Error().Err(err).Msg("upload: hash copy failed")
		return c.Status(500).JSON(fiber.Map{"error": "hash: " + err.Error()})
	}

	obj := &models.FileObject{
		TenantID:    tenantID,
		Name:        name,
		Kind:        kind,
		StorageKey:  storageKey,
		SHA256:      hex.EncodeToString(h1.Sum(nil)),
		SizeBytes:   mf.Size,
		ContentType: mf.Header.Get("Content-Type"),
	}
	if byDevice {
		did := deviceOf(c)
		obj.UploadedByDevice = &did
		obj.DeviceID = &did
	} else {
		uid := userOf(c)
		obj.UploadedBy = &uid
		if dStr := c.FormValue("device_id"); dStr != "" {
			if d, err := uuid.Parse(dStr); err == nil {
				obj.DeviceID = &d
			}
		}
	}
	if err := h.repo.Insert(c.Context(), obj); err != nil {
		log.Error().Err(err).Str("kind", kind).Str("name", name).Msg("upload: DB persist failed")
		return c.Status(500).JSON(fiber.Map{"error": "persist: " + err.Error()})
	}
	return c.Status(201).JSON(obj)
}

// SessionAudio stitches a recording session's segments into a single
// continuous .aac and returns a presigned URL to it. Segments are AAC/ADTS,
// which concatenate by simple byte-append (no transcoder needed), so the admin
// UI can play a whole session as one scrubbable track instead of N clips. The
// stitched object is cached and only rebuilt when a newer segment appears.
func (h *Handler) SessionAudio(c *fiber.Ctx) error {
	session := c.Params("sessionID")
	if session == "" {
		return c.Status(400).JSON(fiber.Map{"error": "missing session"})
	}
	tenantID := tenantOf(c)
	segs, err := h.repo.ListAudioSegments(c.Context(), tenantID, session)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	if len(segs) == 0 {
		return c.Status(404).JSON(fiber.Map{"error": "no audio for session"})
	}
	// Only ADTS/AAC segments byte-concatenate cleanly. Legacy MP4 (.m4a)
	// sessions can't be stitched without a transcoder — signal the UI to fall
	// back to its sequential player.
	for _, s := range segs {
		if !strings.HasSuffix(strings.ToLower(s.Name), ".aac") {
			return c.Status(422).JSON(fiber.Map{"error": "session not stitchable (legacy format)"})
		}
	}

	stitchedKey := stitchedSessionKey(tenantID, session)

	// Cache: only rebuild if a segment is newer than the stitched file.
	var newest time.Time
	for _, s := range segs {
		if s.CreatedAt.After(newest) {
			newest = s.CreatedAt
		}
	}
	lm, exists, _ := h.store.Stat(c.Context(), stitchedKey)
	if !exists || !lm.After(newest) {
		var buf bytes.Buffer
		for i, s := range segs {
			rc, err := h.store.Get(c.Context(), s.StorageKey)
			if err != nil {
				return c.Status(500).JSON(fiber.Map{"error": "read segment: " + err.Error()})
			}
			segBytes, rErr := io.ReadAll(rc)
			rc.Close()
			if rErr != nil {
				return c.Status(500).JSON(fiber.Map{"error": "concat: " + rErr.Error()})
			}
			// Keep the first segment whole; strip the encoder-priming silence
			// from every subsequent one so the joins are seamless.
			if i == 0 {
				buf.Write(segBytes)
			} else {
				writeADTSWithoutPriming(&buf, segBytes, aacEncoderDelayFrames)
			}
		}
		if err := h.store.Put(c.Context(), stitchedKey, bytes.NewReader(buf.Bytes()), int64(buf.Len()), "audio/aac"); err != nil {
			return c.Status(500).JSON(fiber.Map{"error": "store stitched: " + err.Error()})
		}
		log.Info().Str("session", session).Int("segments", len(segs)).Int("bytes", buf.Len()).Msg("stitched audio session")
	}

	url, err := h.store.PresignDownloadFor(c.Context(), stitchedKey, time.Hour, publicEndpointFromRequest(c))
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"url": url, "expires_in": 3600, "segments": len(segs)})
}

func (h *Handler) List(c *fiber.Ctx) error {
	filt := repository.ListFilter{TenantID: tenantOf(c), Kind: c.Query("kind")}
	if s := c.Query("device_id"); s != "" {
		if d, err := uuid.Parse(s); err == nil {
			filt.DeviceID = &d
		}
	}
	out, err := h.repo.List(c.Context(), filt)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"items": out})
}

// Presign returns a short-lived download URL for a stored object.
//
// Host selection: the URL is signed against whatever host the admin browser
// is currently reaching the server at (X-Forwarded-Host from our admin nginx,
// falling back to the Host header on the inbound request). This means a
// laptop on the office LAN, a phone tethered to cellular, and a remote VPN
// client all get a URL that resolves on THEIR network without any static
// MINIO_PUBLIC_ENDPOINT reconfiguration. The companion nginx location at
// `/mdm-files/` proxies the actual byte-range request to the internal
// minio:9000 endpoint while preserving Host so the SigV4 check passes.
func (h *Handler) Presign(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}
	obj, err := h.repo.Get(c.Context(), tenantOf(c), id)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "not found"})
	}
	pubEndpoint := publicEndpointFromRequest(c)
	// 1 hour TTL. A large APK on a slow mobile link can easily blow past the
	// old 10-min budget — by the time the agent finishes streaming, MinIO has
	// already started rejecting range requests with 403 "Request has expired",
	// which the agent then reports as the misleading "empty body" error.
	const ttl = time.Hour
	url, err := h.store.PresignDownloadFor(c.Context(), obj.StorageKey, ttl, pubEndpoint)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"url": url, "expires_in": int(ttl.Seconds()), "sha256": obj.SHA256, "size": obj.SizeBytes})
}

// publicEndpointFromRequest returns "scheme://host[:port]" the admin's
// browser used to hit the API, or "" if nothing useful is on the request.
// nginx's proxy.inc sets both X-Forwarded-Host and X-Forwarded-Proto.
func publicEndpointFromRequest(c *fiber.Ctx) string {
	host := c.Get("X-Forwarded-Host")
	if host == "" {
		host = c.Hostname()
	}
	if host == "" {
		return ""
	}
	proto := c.Get("X-Forwarded-Proto")
	if proto == "" {
		proto = "http"
	}
	return proto + "://" + host
}

// LatestAgentAPK is a public (no-auth) redirect to the most recently uploaded
// APK for a tenant. Android's Setup Wizard calls this URL during QR
// provisioning — before the device has any auth token — so it must be
// unauthenticated. The tenant is passed as a ?tenant=<uuid> query param that
// the enrollment service embeds in the QR payload's android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION field.
//
// The redirect target is a 6-hour presigned MinIO URL so large APKs on slow
// mobile connections finish downloading even with range retries.
func (h *Handler) LatestAgentAPK(c *fiber.Ctx) error {
	tenantStr := c.Query("tenant", "")
	tenantID, err := uuid.Parse(tenantStr)
	if err != nil || tenantID == uuid.Nil {
		return c.Status(400).JSON(fiber.Map{"error": "tenant query param required (uuid)"})
	}
	files, err := h.repo.List(c.Context(), repository.ListFilter{TenantID: tenantID, Kind: "apk"})
	if err != nil || len(files) == 0 {
		return c.Status(404).JSON(fiber.Map{"error": "no agent APK uploaded for this tenant — go to Settings → Agent APK builds"})
	}
	// List returns newest-first (ORDER BY created_at DESC).
	latest := files[0]
	pubEndpoint := publicEndpointFromRequest(c)
	const ttl = 6 * time.Hour
	url, err := h.store.PresignDownloadFor(c.Context(), latest.StorageKey, ttl, pubEndpoint)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	// 302 redirect — the Setup Wizard follows redirects automatically.
	return c.Redirect(url, fiber.StatusFound)
}

func (h *Handler) Delete(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}
	tenantID := tenantOf(c)
	// Read before deleting so we can invalidate the stitched-session cache if
	// this is an audio segment — otherwise the cached stitch keeps serving the
	// deleted segment's audio (it's newer than the remaining segments, so the
	// freshness check wouldn't rebuild it).
	obj, _ := h.repo.Get(c.Context(), tenantID, id)
	if err := h.repo.SoftDelete(c.Context(), tenantID, id); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	if obj != nil && obj.Kind == "audio" {
		if sess := audioSessionFromName(obj.Name); sess != "" {
			_ = h.store.Delete(c.Context(), stitchedSessionKey(tenantID, sess))
		}
	}
	return c.SendStatus(204)
}

// DeleteSession removes an entire recording session: every audio segment plus
// the cached stitched file. Idempotent — deleting an already-empty session is
// a no-op that still clears any stale stitched cache.
func (h *Handler) DeleteSession(c *fiber.Ctx) error {
	session := c.Params("sessionID")
	if session == "" {
		return c.Status(400).JSON(fiber.Map{"error": "missing session"})
	}
	tenantID := tenantOf(c)
	segs, err := h.repo.ListAudioSegments(c.Context(), tenantID, session)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	for _, s := range segs {
		if err := h.repo.SoftDelete(c.Context(), tenantID, s.ID); err != nil {
			return c.Status(500).JSON(fiber.Map{"error": err.Error()})
		}
	}
	_ = h.store.Delete(c.Context(), stitchedSessionKey(tenantID, session))
	return c.JSON(fiber.Map{"deleted": len(segs)})
}

// stitchedSessionKey is the deterministic MinIO key for a session's stitched
// audio (no DB row — presigned directly). The `gapless` segment versions the
// stitching algorithm: bumping it invalidates caches built by an older,
// priming-preserving stitch so sessions re-stitch gaplessly on next play.
func stitchedSessionKey(tenantID uuid.UUID, session string) string {
	return fmt.Sprintf("audio_session/%s/%s.gapless.aac", tenantID, session)
}

// aacEncoderDelayFrames is how many leading AAC-LC frames to drop from each
// stitched-in segment. Android's AAC encoder emits ~2048 samples (2 frames of
// 1024) of lookahead "priming" that decode to silence at the start of every
// independently-encoded segment; dropping them removes the ~46ms blank that
// would otherwise land at each segment boundary in the stitched track.
const aacEncoderDelayFrames = 2

// writeADTSWithoutPriming copies an ADTS/AAC segment into dst with the first
// `frames` ADTS frames removed. If the data doesn't start on a valid ADTS
// frame, it copies verbatim instead — so a parse anomaly degrades to the old
// (small-gap) behaviour rather than corrupting the stream.
func writeADTSWithoutPriming(dst *bytes.Buffer, seg []byte, frames int) {
	i, skipped := 0, 0
	for skipped < frames && i+7 <= len(seg) {
		// ADTS syncword = 0xFFF in the high 12 bits.
		if seg[i] != 0xFF || seg[i+1]&0xF0 != 0xF0 {
			dst.Write(seg)
			return
		}
		// frame_length is 13 bits spanning bytes 3..5 of the header.
		frameLen := int(seg[i+3]&0x03)<<11 | int(seg[i+4])<<3 | int(seg[i+5])>>5
		if frameLen < 7 || i+frameLen > len(seg) {
			dst.Write(seg)
			return
		}
		i += frameLen
		skipped++
	}
	dst.Write(seg[i:])
}

// audioSessionFromName extracts the session id from a segment file name shaped
// like audio_<session>_<seq>_<ts>.ext (session ids never contain '_').
func audioSessionFromName(name string) string {
	if !strings.HasPrefix(name, "audio_") {
		return ""
	}
	parts := strings.SplitN(name, "_", 3) // ["audio", <session>, <rest>]
	if len(parts) < 3 {
		return ""
	}
	return parts[1]
}

func tenantOf(c *fiber.Ctx) uuid.UUID {
	s, _ := c.Locals(middleware.CtxTenantID).(string)
	t, _ := uuid.Parse(s)
	return t
}
func userOf(c *fiber.Ctx) uuid.UUID {
	s, _ := c.Locals(middleware.CtxUserID).(string)
	t, _ := uuid.Parse(s)
	return t
}
func deviceOf(c *fiber.Ctx) uuid.UUID {
	s, _ := c.Locals(middleware.CtxDeviceID).(string)
	t, _ := uuid.Parse(s)
	return t
}
