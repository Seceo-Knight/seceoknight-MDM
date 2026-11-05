// Package notify wakes HTTP long-poll waiters the instant a command is created
// for a device, so command delivery is near-realtime without MQTT.
//
// In-memory and single-process: dev runs one command-service replica, so a map
// of per-device waiter channels is enough. To scale to multiple replicas, back
// this with a per-device NATS subject (mdm.cmd.notify.<id>) — Notify publishes,
// Wait subscribes — without changing callers.
package notify

import (
	"sync"

	"github.com/google/uuid"
)

type Notifier struct {
	mu      sync.Mutex
	waiters map[uuid.UUID][]chan struct{}
}

func New() *Notifier {
	return &Notifier{waiters: make(map[uuid.UUID][]chan struct{})}
}

// Wait registers a one-shot waiter for deviceID and returns its channel plus a
// cancel func the caller MUST defer (deregisters the waiter if it gives up — on
// timeout or client disconnect — before being notified). The channel is closed
// by Notify. Register the waiter BEFORE the pre-claim check so a command created
// in the gap still wakes it.
func (n *Notifier) Wait(deviceID uuid.UUID) (<-chan struct{}, func()) {
	ch := make(chan struct{})
	n.mu.Lock()
	n.waiters[deviceID] = append(n.waiters[deviceID], ch)
	n.mu.Unlock()

	cancel := func() {
		n.mu.Lock()
		defer n.mu.Unlock()
		list := n.waiters[deviceID]
		for i, c := range list {
			if c == ch {
				n.waiters[deviceID] = append(list[:i], list[i+1:]...)
				break
			}
		}
		if len(n.waiters[deviceID]) == 0 {
			delete(n.waiters, deviceID)
		}
	}
	return ch, cancel
}

// Notify wakes (and drops) every current waiter for deviceID by closing their
// channels. Safe to call when there are no waiters.
func (n *Notifier) Notify(deviceID uuid.UUID) {
	n.mu.Lock()
	list := n.waiters[deviceID]
	delete(n.waiters, deviceID)
	n.mu.Unlock()
	for _, ch := range list {
		close(ch)
	}
}
