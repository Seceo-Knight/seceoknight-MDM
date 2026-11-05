// Package signal is a minimal WebRTC signaling relay: it forwards SDP
// offers/answers and ICE candidates between an Android agent (the "device" side)
// and one or more admin browsers (the "viewer" side), grouped into a room per
// (tenant, device). It is content-agnostic — it never parses the signaling
// payloads, it just fans them the right direction: device → all viewers,
// viewer → the device.
package signal

import (
	"sync"
	"time"

	"github.com/gofiber/contrib/websocket"
	"github.com/rs/zerolog/log"
)

// client wraps a connection with a write mutex — the websocket lib is not safe
// for concurrent writers.
type client struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

func (c *client) send(mt int, data []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.conn.WriteMessage(mt, data); err != nil {
		log.Debug().Err(err).Msg("signal: relay write failed")
	}
}

// Ping sends a WebSocket ping control frame, sharing the write mutex with send()
// so it never races a relay write. Keeps an otherwise-idle relay socket alive so
// a network intermediary doesn't drop it (1006) before the peer's offer/answer.
func (c *client) Ping() {
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second))
}

// room is one (tenant, device) signaling session: a single device side + N viewers.
type room struct {
	device  *client
	viewers map[*websocket.Conn]*client
}

type Hub struct {
	mu    sync.Mutex
	rooms map[string]*room
}

func NewHub() *Hub { return &Hub{rooms: map[string]*room{}} }

func (h *Hub) roomFor(key string) *room {
	r := h.rooms[key]
	if r == nil {
		r = &room{viewers: map[*websocket.Conn]*client{}}
		h.rooms[key] = r
	}
	return r
}

// Register adds a connection to its room and returns its client handle (used by
// the handler to drive keepalive pings). role is "device" or "viewer".
func (h *Hub) Register(key, role string, conn *websocket.Conn) *client {
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.roomFor(key)
	cl := &client{conn: conn}
	if role == "device" {
		r.device = cl
	} else {
		r.viewers[conn] = cl
	}
	log.Info().Str("key", key).Str("role", role).
		Bool("hasDevice", r.device != nil).Int("viewers", len(r.viewers)).
		Msg("signal: register")
	return cl
}

// Unregister removes a connection; an empty room is dropped.
func (h *Hub) Unregister(key, role string, conn *websocket.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.rooms[key]
	if r == nil {
		return
	}
	if role == "device" {
		if r.device != nil && r.device.conn == conn {
			r.device = nil
		}
	} else {
		delete(r.viewers, conn)
	}
	if r.device == nil && len(r.viewers) == 0 {
		delete(h.rooms, key)
	}
	log.Info().Str("key", key).Str("role", role).Msg("signal: unregister")
}

// Relay fans a message from one side to the other: device → all viewers, a
// viewer → the device. Targets are snapshotted under the lock, then written
// outside it so a slow/blocked writer can't stall the whole hub.
func (h *Hub) Relay(key, fromRole string, mt int, data []byte) {
	h.mu.Lock()
	r := h.rooms[key]
	if r == nil {
		h.mu.Unlock()
		return
	}
	var targets []*client
	if fromRole == "device" {
		for _, v := range r.viewers {
			targets = append(targets, v)
		}
	} else if r.device != nil {
		targets = append(targets, r.device)
	}
	h.mu.Unlock()
	log.Info().Str("key", key).Str("from", fromRole).Int("targets", len(targets)).Int("bytes", len(data)).Msg("signal: relay")
	for _, t := range targets {
		t.send(mt, data)
	}
}
