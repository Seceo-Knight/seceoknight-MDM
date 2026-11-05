// Package bridge subscribes to NATS subjects (e.g. mdm.device.heartbeat) and
// fans them out to:
//   - MQTT topics under mdm/<tenant>/server/events for devices that want
//     server-side broadcasts; and
//   - the local WebSocket hub, so the admin web sees live updates.
package bridge

import (
	"context"
	"encoding/json"

	mqtt "github.com/eclipse/paho.mqtt.golang"
	"github.com/nats-io/nats.go"
	"github.com/rs/zerolog/log"

	"github.com/mdm/notification-service/internal/ws"
)

type Bridge struct {
	js   nats.JetStreamContext
	mqtt mqtt.Client
	hub  *ws.Hub
}

func New(js nats.JetStreamContext, mc mqtt.Client, hub *ws.Hub) *Bridge {
	return &Bridge{js: js, mqtt: mc, hub: hub}
}

func (b *Bridge) Run(ctx context.Context) error {
	subs := []string{
		"mdm.device.enrolled",
		"mdm.device.heartbeat",
		"mdm.device.retired",
		"mdm.command.completed",
	}
	for _, subj := range subs {
		s := subj // capture
		if _, err := b.js.Subscribe(s, func(m *nats.Msg) {
			b.handle(s, m.Data)
			_ = m.Ack()
		}, nats.AckExplicit(), nats.DeliverNew()); err != nil {
			log.Error().Err(err).Str("subj", s).Msg("nats subscribe")
			return err
		}
	}
	<-ctx.Done()
	return nil
}

func (b *Bridge) handle(subject string, data []byte) {
	// Send to web sockets — admin web filters by tenant.
	b.hub.Broadcast(ws.Event{Subject: subject, Data: json.RawMessage(data)})

	// Optionally re-publish to MQTT under a server-events topic.
	var env map[string]any
	if err := json.Unmarshal(data, &env); err != nil {
		return
	}
	tenant, _ := env["tenant_id"].(string)
	if tenant == "" {
		return
	}
	topic := "mdm/" + tenant + "/server/events"
	tok := b.mqtt.Publish(topic, 0, false, data)
	tok.Wait()
}
