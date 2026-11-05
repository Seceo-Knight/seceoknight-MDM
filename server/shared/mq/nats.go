// Package mq wraps NATS JetStream for inter-service eventing.
package mq

import (
	"fmt"

	"github.com/nats-io/nats.go"
)

type Bus struct {
	Conn *nats.Conn
	JS   nats.JetStreamContext
}

func Connect(url string) (*Bus, error) {
	nc, err := nats.Connect(url, nats.MaxReconnects(-1))
	if err != nil {
		return nil, fmt.Errorf("nats: %w", err)
	}
	js, err := nc.JetStream()
	if err != nil {
		return nil, fmt.Errorf("nats jetstream: %w", err)
	}
	return &Bus{Conn: nc, JS: js}, nil
}

// EnsureStreams declares the JetStream streams used by the platform. Idempotent.
func (b *Bus) EnsureStreams() error {
	streams := []*nats.StreamConfig{
		{Name: "DEVICE_EVENTS", Subjects: []string{"mdm.device.*"}, Retention: nats.LimitsPolicy, MaxAge: 0},
		{Name: "COMMANDS", Subjects: []string{"mdm.command.*"}, Retention: nats.WorkQueuePolicy},
		{Name: "TELEMETRY", Subjects: []string{"mdm.telemetry.*"}, Retention: nats.LimitsPolicy},
		{Name: "AUDIT", Subjects: []string{"mdm.audit.*"}, Retention: nats.LimitsPolicy},
	}
	for _, s := range streams {
		if _, err := b.JS.AddStream(s); err != nil && err != nats.ErrStreamNameAlreadyInUse {
			// AddStream is idempotent in practice — only return real errors
			if _, e2 := b.JS.UpdateStream(s); e2 != nil {
				return fmt.Errorf("stream %s: %w", s.Name, err)
			}
		}
	}
	return nil
}
