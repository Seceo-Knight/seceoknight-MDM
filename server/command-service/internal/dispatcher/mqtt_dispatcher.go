// Package dispatcher pushes commands to devices over MQTT. Each enrolled
// device subscribes to `mdm/<tenant>/devices/<device>/cmd` with QoS 1; the
// dispatcher publishes a single JSON payload per command.
//
// Reliability strategy:
//  1. The HTTP layer writes the command row in `pending` state.
//  2. Dispatcher polls Postgres for pending commands every `tickInterval` and
//     publishes them. (Postgres LISTEN/NOTIFY would be a future optimization.)
//  3. ClaimPending uses SELECT ... FOR UPDATE SKIP LOCKED so multiple
//     dispatcher instances can run safely.
//  4. The device ACKs by POST /commands/:id/ack and reports completion by POST
//     /commands/:id/result; the result moves state to succeeded/failed.
//  5. A separate timeout reconciler moves stuck commands to `timed_out`.
package dispatcher

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
	"github.com/rs/zerolog/log"

	"github.com/mdm/command-service/internal/repository"
	"github.com/mdm/shared/models"
)

type Dispatcher struct {
	repo         *repository.CommandRepo
	mqtt         mqtt.Client
	tickInterval time.Duration
}

func New(repo *repository.CommandRepo, client mqtt.Client) *Dispatcher {
	// 500ms tick → a newly-created command is published to MQTT within half a
	// second, so an online device executes it near-realtime (the previous 2s
	// tick was the dominant felt latency once MQTT itself was stable). The poll
	// for pending work is a cheap indexed query; 2×/s is negligible. (A
	// LISTEN/NOTIFY wake-on-insert would make it truly instant — future work.)
	return &Dispatcher{repo: repo, mqtt: client, tickInterval: 500 * time.Millisecond}
}

func (d *Dispatcher) Run(ctx context.Context) {
	tick := time.NewTicker(d.tickInterval)
	defer tick.Stop()
	timeoutTick := time.NewTicker(30 * time.Second)
	defer timeoutTick.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-timeoutTick.C:
			if n, err := d.repo.TimeoutOverdue(ctx, time.Now()); err == nil && n > 0 {
				log.Info().Int64("count", n).Msg("commands timed out")
			}
		case <-tick.C:
			// (This is a naive global poll. In production, partition by tenant
			// hash so multiple dispatcher pods divide the work.)
			d.dispatchOnce(ctx)
		}
	}
}

func (d *Dispatcher) dispatchOnce(ctx context.Context) {
	// We don't know which device IDs are pending without first scanning;
	// the simplest correct approach is one SQL pull of pending commands that
	// FOR UPDATE SKIP LOCKEDs across devices. We loop a few cycles to drain.
	for i := 0; i < 32; i++ {
		// Pull a batch using a fake "all devices" trick: scan any device with
		// pending work. (A tiny query first finds candidate device IDs.)
		dids, err := d.candidateDevices(ctx, 32)
		if err != nil {
			log.Error().Err(err).Msg("candidate devices")
			return
		}
		if len(dids) == 0 {
			return
		}
		for _, did := range dids {
			cmds, err := d.repo.ClaimPending(ctx, did, 16)
			if err != nil {
				log.Error().Err(err).Msg("claim pending")
				continue
			}
			for _, c := range cmds {
				d.publish(c)
			}
		}
	}
}

// candidateDevices returns device IDs that currently have pending commands.
// Cheap by index on (state, ...).
func (d *Dispatcher) candidateDevices(ctx context.Context, limit int) ([]uuidLite, error) {
	type row struct {
		DeviceID uuidLite `db:"device_id"`
	}
	rows := []row{}
	const q = `SELECT DISTINCT device_id FROM commands
	            WHERE state = 'pending' ORDER BY device_id LIMIT $1`
	if err := repoSelect(d.repo, ctx, &rows, q, limit); err != nil {
		return nil, err
	}
	out := make([]uuidLite, 0, len(rows))
	for _, r := range rows {
		out = append(out, r.DeviceID)
	}
	return out, nil
}

func (d *Dispatcher) publish(c models.Command) {
	topic := fmt.Sprintf("mdm/%s/devices/%s/cmd", c.TenantID, c.DeviceID)
	body, _ := json.Marshal(map[string]any{
		"id":         c.ID,
		"kind":       c.Kind,
		"payload":    c.Payload,
		"timeout_at": c.TimeoutAt,
		"issued_at":  time.Now(),
	})
	tok := d.mqtt.Publish(topic, 1, false, body)
	if !tok.WaitTimeout(3 * time.Second) {
		log.Warn().Str("cmd", c.ID.String()).Msg("mqtt publish timeout")
		return
	}
	if err := tok.Error(); err != nil {
		log.Error().Err(err).Str("cmd", c.ID.String()).Msg("mqtt publish")
	}
}
