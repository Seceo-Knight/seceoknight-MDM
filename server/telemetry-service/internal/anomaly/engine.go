// Package anomaly — the AI detection engine.
//
// Run() spawns a background goroutine that fires every 5 minutes. For each
// active device it:
//   1. Pulls the last 7 days of telemetry samples from Postgres.
//   2. Computes rolling mean + standard deviation (Welford's online algorithm).
//   3. Compares the latest device snapshot against the baseline.
//   4. Emits a device_anomalies row whenever a Z-score crosses the thresholds
//      (2.0 → warning, 3.0 → critical), subject to a 1-hour cooldown.
//
// All anomaly types are purely statistical — no ML model needed. This keeps
// the engine self-contained and dependency-free while still being far more
// sophisticated than simple threshold alerts.
package anomaly

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"time"

	"github.com/rs/zerolog/log"
)

// thresholds for triggering anomalies
const (
	zWarn     = 2.0 // warning: 2 standard deviations from baseline
	zCritical = 3.0 // critical: 3 standard deviations
	minSamples = 20  // need at least this many data points before trusting the baseline
)

// Engine runs the anomaly detection loop.
type Engine struct {
	store          *Store
	interval       time.Duration
	alertServiceURL string
}

// New creates an Engine. interval controls how often the analysis runs
// (5 * time.Minute in production).
func New(store *Store, interval time.Duration) *Engine {
	alertURL := os.Getenv("ALERT_SERVICE_URL")
	if alertURL == "" {
		alertURL = "http://alert-service:8010"
	}
	return &Engine{store: store, interval: interval, alertServiceURL: alertURL}
}

// Run starts the background goroutine. It returns immediately.
// Cancel ctx to stop the loop cleanly.
func (e *Engine) Run(ctx context.Context) {
	go func() {
		// Stagger the first run by 30 seconds so it doesn't fire the instant
		// the service boots (let the DB connections warm up first).
		select {
		case <-ctx.Done():
			return
		case <-time.After(30 * time.Second):
		}
		e.runOnce(ctx)
		ticker := time.NewTicker(e.interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				e.runOnce(ctx)
			}
		}
	}()
}

// runOnce executes one full analysis pass across all active devices.
func (e *Engine) runOnce(ctx context.Context) {
	devices, err := e.store.ActiveDevices(ctx)
	if err != nil {
		log.Error().Err(err).Msg("anomaly: failed to load active devices")
		return
	}
	log.Info().Int("devices", len(devices)).Msg("anomaly: starting analysis pass")

	for _, d := range devices {
		if err := e.analyzeDevice(ctx, d); err != nil {
			log.Warn().Err(err).Stringer("device_id", d.ID).Msg("anomaly: device analysis error")
		}
	}
}

// analyzeDevice runs all anomaly detectors for one device.
func (e *Engine) analyzeDevice(ctx context.Context, d DeviceRow) error {
	// ── 1. Build / refresh baselines ─────────────────────────────────────────
	bl := Baseline{DeviceID: d.ID, TenantID: d.TenantID}

	// Battery
	battSamples, _ := e.store.BatterySamples(ctx, d.TenantID, d.ID)
	if len(battSamples) >= minSamples {
		avg, std := meanStd(battSamples)
		bl.BatteryAvg, bl.BatteryStd = &avg, &std
		bl.BatterySamples = len(battSamples)
	}

	// Posture
	postureSamples, _ := e.store.PostureSamples(ctx, d.TenantID, d.ID)
	if len(postureSamples) >= minSamples {
		avg, std := meanStd(postureSamples)
		bl.PostureAvg, bl.PostureStd = &avg, &std
		bl.PostureSamples = len(postureSamples)
	}

	// Heartbeat interval
	hbRows, _ := e.store.HeartbeatTimes(ctx, d.TenantID, d.ID)
	if len(hbRows) >= minSamples {
		intervals := heartbeatIntervals(hbRows)
		if len(intervals) >= minSamples {
			avg, std := meanStd(intervals)
			bl.HbIntervalAvg, bl.HbIntervalStd = &avg, &std
			bl.HbSamples = len(intervals)
		}
	}

	// Storage
	storageSamples, _ := e.store.StorageSamples(ctx, d.TenantID, d.ID)
	if len(storageSamples) >= minSamples {
		avg, std := meanStd(storageSamples)
		bl.StorageAvg, bl.StorageStd = &avg, &std
		bl.StorageSamples = len(storageSamples)
	}

	if err := e.store.UpsertBaseline(ctx, bl); err != nil {
		return fmt.Errorf("upsert baseline: %w", err)
	}

	// ── 2. Run detectors using latest device snapshot ─────────────────────────
	e.detectBatteryDrain(ctx, d, bl)
	e.detectPostureDrop(ctx, d, bl)
	e.detectOfflineSpike(ctx, d, bl, hbRows)
	e.detectStorageDrop(ctx, d, bl)
	e.detectAppBurst(ctx, d)

	return nil
}

// ─── Detectors ───────────────────────────────────────────────────────────────

// detectBatteryDrain flags devices whose current battery is significantly
// below the 7-day baseline — typical indicator of crypto mining or malware.
func (e *Engine) detectBatteryDrain(ctx context.Context, d DeviceRow, bl Baseline) {
	if d.LastBatteryPct == nil || bl.BatteryAvg == nil || bl.BatteryStd == nil {
		return
	}
	if bl.BatterySamples < minSamples || *bl.BatteryStd < 0.5 {
		return // too little variance to judge
	}
	z := (*bl.BatteryAvg - float64(*d.LastBatteryPct)) / *bl.BatteryStd // positive = below average
	if z < zWarn {
		return
	}
	severity := "warning"
	if z >= zCritical {
		severity = "critical"
	}
	e.maybeInsert(ctx, d, "battery_drain", severity, z,
		fmt.Sprintf("Battery %d%% is %.1fσ below the %.0f%% 7-day average — possible crypto miner or background malware",
			*d.LastBatteryPct, z, *bl.BatteryAvg),
		map[string]any{
			"current_pct":  *d.LastBatteryPct,
			"baseline_avg": *bl.BatteryAvg,
			"baseline_std": *bl.BatteryStd,
			"z_score":      z,
		},
	)
}

// detectPostureDrop flags a sudden drop in device attestation score.
func (e *Engine) detectPostureDrop(ctx context.Context, d DeviceRow, bl Baseline) {
	if d.LastPostureScore == nil || bl.PostureAvg == nil || bl.PostureStd == nil {
		return
	}
	if bl.PostureSamples < minSamples || *bl.PostureStd < 1.0 {
		return
	}
	z := (*bl.PostureAvg - float64(*d.LastPostureScore)) / *bl.PostureStd
	if z < zWarn {
		return
	}
	severity := "warning"
	if z >= zCritical {
		severity = "critical"
	}
	e.maybeInsert(ctx, d, "posture_drop", severity, z,
		fmt.Sprintf("Posture score %d is %.1fσ below the %.0f baseline — device may be rooted or compromised",
			*d.LastPostureScore, z, *bl.PostureAvg),
		map[string]any{
			"current_score": *d.LastPostureScore,
			"baseline_avg":  *bl.PostureAvg,
			"baseline_std":  *bl.PostureStd,
			"z_score":       z,
		},
	)
}

// detectOfflineSpike flags an unusually long silence between heartbeats —
// could indicate the device was powered off, in airplane mode, or tampered.
func (e *Engine) detectOfflineSpike(ctx context.Context, d DeviceRow, bl Baseline, hbRows []HeartbeatRow) {
	if bl.HbIntervalAvg == nil || bl.HbIntervalStd == nil || bl.HbSamples < minSamples {
		return
	}
	if d.LastHeartbeatAt == nil {
		return
	}
	// Current gap: seconds since last heartbeat
	gapSec := time.Since(*d.LastHeartbeatAt).Seconds()
	if *bl.HbIntervalStd < 10 { // less than 10-second std — not enough variance
		return
	}
	z := (gapSec - *bl.HbIntervalAvg) / *bl.HbIntervalStd
	if z < zWarn {
		return
	}
	severity := "warning"
	if z >= zCritical {
		severity = "critical"
	}
	e.maybeInsert(ctx, d, "offline_spike", severity, z,
		fmt.Sprintf("Device has been silent for %.0f min — %.1fσ above the %.0f min typical interval",
			gapSec/60, z, *bl.HbIntervalAvg/60),
		map[string]any{
			"gap_seconds":        gapSec,
			"baseline_avg_secs":  *bl.HbIntervalAvg,
			"baseline_std_secs":  *bl.HbIntervalStd,
			"z_score":            z,
			"last_heartbeat_at":  d.LastHeartbeatAt,
		},
	)
}

// detectStorageDrop flags a sudden drop in free storage — ransomware encrypting
// data or malware exfiltrating a copy.
func (e *Engine) detectStorageDrop(ctx context.Context, d DeviceRow, bl Baseline) {
	if d.LastStorageFreeBytes == nil || bl.StorageAvg == nil || bl.StorageStd == nil {
		return
	}
	if bl.StorageSamples < minSamples || *bl.StorageStd < 1_000_000 { // ignore < 1 MB std
		return
	}
	z := (*bl.StorageAvg - float64(*d.LastStorageFreeBytes)) / *bl.StorageStd
	if z < zWarn {
		return
	}
	severity := "warning"
	if z >= zCritical {
		severity = "critical"
	}
	gb := float64(*d.LastStorageFreeBytes) / 1e9
	avgGb := *bl.StorageAvg / 1e9
	e.maybeInsert(ctx, d, "storage_drop", severity, z,
		fmt.Sprintf("Free storage %.1f GB is %.1fσ below the %.1f GB baseline — possible ransomware or data exfil",
			gb, z, avgGb),
		map[string]any{
			"current_free_bytes":  *d.LastStorageFreeBytes,
			"baseline_avg_bytes":  *bl.StorageAvg,
			"baseline_std_bytes":  *bl.StorageStd,
			"z_score":             z,
		},
	)
}

// detectAppBurst flags a sudden large increase in installed apps — malware
// installers typically push dozens of apps at once.
func (e *Engine) detectAppBurst(ctx context.Context, d DeviceRow) {
	appRows, err := e.store.AppInventoryCounts(ctx, d.TenantID, d.ID)
	if err != nil || len(appRows) < 3 {
		return
	}
	counts := make([]float64, len(appRows))
	for i, r := range appRows {
		counts[i] = float64(r.AppCount)
	}
	avg, std := meanStd(counts[1:]) // baseline = all historical except latest
	if std < 1 {
		return
	}
	current := counts[0]
	z := (current - avg) / std
	if z < zWarn {
		return
	}
	severity := "warning"
	if z >= zCritical {
		severity = "critical"
	}
	e.maybeInsert(ctx, d, "app_burst", severity, z,
		fmt.Sprintf("%.0f apps installed — %.1fσ above the %.0f-app baseline — possible malware installer",
			current, z, avg),
		map[string]any{
			"current_app_count":  int(current),
			"baseline_avg_count": avg,
			"baseline_std_count": std,
			"z_score":            z,
		},
	)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// maybeInsert inserts an anomaly only if no cooldown is active.
func (e *Engine) maybeInsert(ctx context.Context, d DeviceRow, anomalyType, severity string, z float64, description string, details map[string]any) {
	active, err := e.store.CooldownActive(ctx, d.TenantID, d.ID, anomalyType)
	if err != nil {
		log.Warn().Err(err).Msg("anomaly: cooldown check failed")
		return
	}
	if active {
		return
	}
	raw, _ := json.Marshal(details)
	a := Anomaly{
		TenantID:    d.TenantID,
		DeviceID:    d.ID,
		AnomalyType: anomalyType,
		Severity:    severity,
		ZScore:      z,
		Description: description,
		Details:     raw,
	}
	if err := e.store.InsertAnomaly(ctx, a); err != nil {
		log.Error().Err(err).Stringer("device_id", d.ID).Str("type", anomalyType).Msg("anomaly: insert failed")
		return
	}
	log.Info().
		Stringer("device_id", d.ID).
		Str("type", anomalyType).
		Str("severity", severity).
		Float64("z_score", z).
		Msg("anomaly: detected")
	// Fire alert notification asynchronously (best-effort).
	go e.notifyAnomaly(d.TenantID.String(), d.ID.String(), anomalyType, severity, z, description)
}

type anomalyAlertRequest struct {
	TenantID  string         `json:"tenant_id"`
	EventType string         `json:"event_type"`
	Subject   string         `json:"subject"`
	Data      map[string]any `json:"data"`
}

// notifyAnomaly fires POST /internal/notify to alert-service (best-effort).
func (e *Engine) notifyAnomaly(tenantID, deviceID, anomalyType, severity string, z float64, description string) {
	eventType := "anomaly_warning"
	if severity == "critical" {
		eventType = "anomaly_critical"
	}
	payload := anomalyAlertRequest{
		TenantID:  tenantID,
		EventType: eventType,
		Subject:   fmt.Sprintf("AI anomaly [%s]: %s", severity, description),
		Data: map[string]any{
			"device_id":    deviceID,
			"anomaly_type": anomalyType,
			"severity":     severity,
			"z_score":      fmt.Sprintf("%.2f", z),
			"description":  description,
		},
	}
	body, _ := json.Marshal(payload)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		e.alertServiceURL+"/internal/notify", bytes.NewReader(body))
	if err != nil {
		log.Warn().Err(err).Msg("anomaly alert: build request failed")
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		log.Warn().Err(err).Msg("anomaly alert: request failed")
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		log.Warn().Int("status", resp.StatusCode).Msg("anomaly alert: non-2xx response")
	}
}

// meanStd computes the mean and population standard deviation of a slice.
// Returns (0,0) for empty or single-element slices.
func meanStd(vals []float64) (mean, std float64) {
	n := len(vals)
	if n == 0 {
		return
	}
	var sum float64
	for _, v := range vals {
		sum += v
	}
	mean = sum / float64(n)
	if n == 1 {
		return
	}
	var variance float64
	for _, v := range vals {
		diff := v - mean
		variance += diff * diff
	}
	std = math.Sqrt(variance / float64(n))
	return
}

// heartbeatIntervals converts a slice of HeartbeatRow (sorted newest→oldest)
// into a slice of inter-heartbeat interval durations in seconds.
func heartbeatIntervals(rows []HeartbeatRow) []float64 {
	if len(rows) < 2 {
		return nil
	}
	out := make([]float64, 0, len(rows)-1)
	for i := 0; i < len(rows)-1; i++ {
		diff := rows[i].CapturedAt.Sub(rows[i+1].CapturedAt).Seconds()
		if diff > 0 {
			out = append(out, diff)
		}
	}
	return out
}
