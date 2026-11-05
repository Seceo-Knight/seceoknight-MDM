// Package ws hosts a thin WebSocket fan-out hub so the admin web can subscribe
// to live device/command events. It is intentionally minimal: real production
// deployments should add tenant filtering at the auth layer and per-tenant
// fan-out fanned by Redis Pub/Sub if running multiple replicas.
package ws

import (
	"encoding/json"
	"sync"

	"github.com/gofiber/contrib/websocket"
	"github.com/rs/zerolog/log"
)

type Event struct {
	Subject string          `json:"subject"`
	Data    json.RawMessage `json:"data"`
}

type Hub struct {
	mu      sync.RWMutex
	clients map[*websocket.Conn]string // conn -> tenant
}

func NewHub() *Hub { return &Hub{clients: map[*websocket.Conn]string{}} }

func (h *Hub) Register(c *websocket.Conn, tenant string) {
	h.mu.Lock()
	h.clients[c] = tenant
	h.mu.Unlock()
}

func (h *Hub) Unregister(c *websocket.Conn) {
	h.mu.Lock()
	delete(h.clients, c)
	h.mu.Unlock()
}

func (h *Hub) Broadcast(e Event) {
	body, err := json.Marshal(e)
	if err != nil {
		return
	}
	// Pull tenant out of event data if present.
	var env struct {
		TenantID string `json:"tenant_id"`
	}
	_ = json.Unmarshal(e.Data, &env)

	h.mu.RLock()
	defer h.mu.RUnlock()
	for c, t := range h.clients {
		if env.TenantID != "" && t != "" && t != env.TenantID {
			continue
		}
		if err := c.WriteMessage(websocket.TextMessage, body); err != nil {
			log.Debug().Err(err).Msg("ws write")
		}
	}
}
