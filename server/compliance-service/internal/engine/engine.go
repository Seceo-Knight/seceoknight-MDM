// Package engine contains the background compliance evaluation loop.
// Every `interval` it loads all enabled rules, fetches device metrics,
// evaluates each rule against each device in the rule's tenant, and
// dispatches commands via the command-service HTTP API when a rule fires.
package engine

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog/log"

	"github.com/mdm/compliance-service/internal/store"
	"github.com/mdm/shared/auth"
)

// Engine is the background compliance evaluation loop.
type Engine struct {
	store            *store.Store
	issuer           *auth.Issuer
	commandServiceURL string
	interval         time.Duration
	// systemUserID is embedded into the JWT the engine uses to call command-service.
	// A well-known UUID that is never a real user; audit logs show "compliance-engine".
	systemUserID uuid.UUID
}

// New constructs an Engine. commandServiceURL defaults to http://command-service:8004.
func New(s *store.Store, issuer *auth.Issuer, commandServiceURL string) *Engine {
	url := commandServiceURL
	if url == "" {
		url = "http://command-service:8004"
	}
	return &Engine{
		store:             s,
		issuer:            issuer,
		commandServiceURL: url,
		interval:          5 * time.Minute,
		// Fixed UUID so audit logs attribute commands to the compliance engine.
		systemUserID: uuid.MustParse("00000000-0000-0000-0000-000000000009"),
	}
}

// Run starts the engine loop and blocks until ctx is cancelled.
func (e *Engine) Run(ctx context.Context) {
	log.Info().Dur("interval", e.interval).Msg("compliance engine started")
	// Run once at start-up, then on each tick.
	e.tick(ctx)
	t := time.NewTicker(e.interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			log.Info().Msg("compliance engine stopped")
			return
		case <-t.C:
			e.tick(ctx)
		}
	}
}

func (e *Engine) tick(ctx context.Context) {
	rules, err := e.store.AllEnabledRules(ctx)
	if err != nil {
		log.Error().Err(err).Msg("compliance: load rules")
		return
	}
	if len(rules) == 0 {
		return
	}

	// Group rules by tenant to minimise device-fetch queries.
	byTenant := map[uuid.UUID][]store.Rule{}
	for _, r := range rules {
		byTenant[r.TenantID] = append(byTenant[r.TenantID], r)
	}

	triggered, skipped, failed := 0, 0, 0
	for tenantID, tenantRules := range byTenant {
		devices, err := e.store.DevicesForTenant(ctx, tenantID)
		if err != nil {
			log.Error().Err(err).Str("tenant", tenantID.String()).Msg("compliance: fetch devices")
			continue
		}
		for _, rule := range tenantRules {
			for _, dev := range devices {
				val, ok := metricValue(dev, rule.TriggerField)
				if !ok {
					continue // device doesn't have this metric yet
				}
				if !evaluate(val, rule.Operator, rule.Threshold) {
					continue // rule not triggered
				}

				// Check cooldown: skip if the last 'triggered' event for this
				// device+rule is younger than cooldown_minutes.
				last, err := e.store.LastEventForDeviceRule(ctx, dev.ID, rule.ID)
				if err != nil && !errors.Is(err, store.ErrNotFound) {
					log.Error().Err(err).Msg("compliance: last event query")
					continue
				}
				cooldownOver := last == nil ||
					time.Since(last.CreatedAt) >= time.Duration(rule.CooldownMinutes)*time.Minute

				if !cooldownOver {
					skipped++
					_ = e.recordEvent(ctx, store.Event{
						RuleID:       rule.ID,
						DeviceID:     dev.ID,
						TenantID:     tenantID,
						TriggerValue: &val,
						Action:       rule.Action,
						Status:       "skipped",
						Note:         fmt.Sprintf("cooldown active, last action %s ago", time.Since(last.CreatedAt).Round(time.Second)),
					})
					continue
				}

				// Dispatch command.
				cmdID, err := e.dispatchCommand(ctx, tenantID, dev.ID, rule)
				ev := store.Event{
					RuleID:       rule.ID,
					DeviceID:     dev.ID,
					TenantID:     tenantID,
					TriggerValue: &val,
					Action:       rule.Action,
				}
				if err != nil {
					ev.Status = "failed"
					ev.Note = err.Error()
					failed++
					log.Error().Err(err).
						Str("rule", rule.Name).Str("device", dev.ID.String()).
						Msg("compliance: dispatch command failed")
				} else {
					ev.Status = "triggered"
					ev.CommandID = cmdID
					triggered++
					log.Info().
						Str("rule", rule.Name).Str("action", rule.Action).
						Str("device", dev.ID.String()).
						Float64("value", val).Float64("threshold", rule.Threshold).
						Msg("compliance: rule fired")
				}
				_ = e.recordEvent(ctx, ev)
			}
		}
	}

	if triggered+skipped+failed > 0 {
		log.Info().
			Int("triggered", triggered).Int("skipped", skipped).Int("failed", failed).
			Msg("compliance tick complete")
	}
}

// metricValue returns the numeric value for the trigger_field from a device row.
func metricValue(d store.DeviceMetric, field string) (float64, bool) {
	switch field {
	case "posture_score":
		if d.PostureScore == nil {
			return 0, false
		}
		return float64(*d.PostureScore), true
	case "battery_level":
		if d.BatteryLevel == nil {
			return 0, false
		}
		return float64(*d.BatteryLevel), true
	}
	return 0, false
}

// evaluate applies the operator comparison.
func evaluate(val float64, op string, threshold float64) bool {
	switch op {
	case "lt":
		return val < threshold
	case "lte":
		return val <= threshold
	case "gt":
		return val > threshold
	case "gte":
		return val >= threshold
	case "eq":
		return val == threshold
	}
	return false
}

type dispatchRequest struct {
	DeviceID    string          `json:"device_id"`
	Kind        string          `json:"kind"`
	Payload     json.RawMessage `json:"payload"`
	MaxAttempts int             `json:"max_attempts"`
}

type dispatchResponse struct {
	ID string `json:"id"`
}

// dispatchCommand calls command-service POST /api/v1/commands with a system JWT.
func (e *Engine) dispatchCommand(ctx context.Context, tenantID, deviceID uuid.UUID, rule store.Rule) (*uuid.UUID, error) {
	// Mint a short-lived admin token scoped to this tenant.
	token, err := e.issuer.IssueUser(e.systemUserID, tenantID, "admin", "")
	if err != nil {
		return nil, fmt.Errorf("mint token: %w", err)
	}

	payload := rule.ActionPayload
	if len(payload) == 0 {
		payload = json.RawMessage(`{}`)
	}

	body, _ := json.Marshal(dispatchRequest{
		DeviceID:    deviceID.String(),
		Kind:        rule.Action,
		Payload:     payload,
		MaxAttempts: 3,
	})

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		e.commandServiceURL+"/api/v1/commands", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("command-service returned %d", resp.StatusCode)
	}

	var dr dispatchResponse
	if err := json.NewDecoder(resp.Body).Decode(&dr); err != nil {
		return nil, err
	}
	id, err := uuid.Parse(dr.ID)
	if err != nil {
		return nil, err
	}
	return &id, nil
}

func (e *Engine) recordEvent(ctx context.Context, ev store.Event) error {
	return e.store.InsertEvent(ctx, &ev)
}
