package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/gofiber/contrib/websocket"
	mqtt "github.com/eclipse/paho.mqtt.golang"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/rs/zerolog/log"

	"github.com/mdm/notification-service/internal/bridge"
	sig "github.com/mdm/notification-service/internal/signal"
	"github.com/mdm/notification-service/internal/ws"
	"github.com/mdm/shared/auth"
	"github.com/mdm/shared/authz"
	"github.com/mdm/shared/config"
	"github.com/mdm/shared/logger"
	"github.com/mdm/shared/middleware"
	"github.com/mdm/shared/mq"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		panic(err)
	}
	logger.Init(cfg.ServiceName, cfg.Env, cfg.LogLevel)

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	bus, err := mq.Connect(cfg.NATSUrl)
	if err != nil {
		log.Fatal().Err(err).Msg("nats")
	}
	_ = bus.EnsureStreams()

	mqttOpts := mqtt.NewClientOptions().
		AddBroker(cfg.MQTTBroker).
		SetClientID("notif-" + uuid.NewString()).
		SetUsername(cfg.MQTTUser).
		SetPassword(cfg.MQTTPass).
		SetAutoReconnect(true)
	mc := mqtt.NewClient(mqttOpts)
	if tok := mc.Connect(); !tok.WaitTimeout(10*time.Second) || tok.Error() != nil {
		log.Warn().Err(tok.Error()).Msg("mqtt; will reconnect in background")
	}

	hub := ws.NewHub()
	br := bridge.New(bus.JS, mc, hub)
	go func() {
		if err := br.Run(ctx); err != nil {
			log.Error().Err(err).Msg("bridge")
		}
	}()

	issuer := auth.NewIssuer(cfg.JWTSecret, cfg.JWTAccessTTL)

	app := fiber.New(fiber.Config{
		AppName: "mdm-notification", DisableStartupMessage: true,
	})
	app.Use(middleware.RequestLogger(), middleware.Recover(), middleware.Metrics(cfg.ServiceName))
	app.Get("/healthz", func(c *fiber.Ctx) error { return c.SendString("ok") })

	app.Use("/ws", func(c *fiber.Ctx) error {
		// "/ws" is prefix-matched, so this also fires for "/ws/signal" — defer that
		// path to its own middleware below (which also authorizes device tokens).
		if strings.HasPrefix(c.Path(), "/ws/signal") {
			return c.Next()
		}
		// Admin auth via Sec-WebSocket-Protocol header — the only way a browser can
		// pass a token on a WS handshake. new WebSocket(url, ['Bearer', token])
		// serializes to "Bearer, <jwt>" (comma); native clients send "Bearer <jwt>".
		claims, err := issuer.Parse(wsBearer(c.Get("Sec-WebSocket-Protocol")))
		if err != nil {
			return c.SendStatus(401)
		}
		c.Locals("tenant", claims.TenantID)
		if websocket.IsWebSocketUpgrade(c) {
			return c.Next()
		}
		return c.SendStatus(fiber.StatusUpgradeRequired)
	})

	// Echo the "Bearer" subprotocol on the upgrade. Browsers connect with
	// new WebSocket(url, ['Bearer', token]) — they OFFER "Bearer" as a subprotocol
	// and Chrome FAILS the socket (closes immediately, code 1006) if the server
	// selects none, even though we parse the token from the header separately.
	// okhttp (the agent) is lenient and doesn't need it. Selecting "Bearer" makes
	// both happy. (The token, offered as a 2nd subprotocol, is never selected.)
	wsCfg := websocket.Config{Subprotocols: []string{"Bearer"}}

	app.Get("/ws", websocket.New(func(c *websocket.Conn) {
		tenant, _ := c.Locals("tenant").(string)
		hub.Register(c, tenant)
		defer hub.Unregister(c)
		// Block on read so the connection stays open. Discard incoming.
		for {
			if _, _, err := c.ReadMessage(); err != nil {
				return
			}
		}
	}, wsCfg))

	// ---- WebRTC screen-share signaling + TURN credentials ----
	sigHub := sig.NewHub()
	turnSecret := os.Getenv("TURN_SECRET")
	turnURL := os.Getenv("TURN_URL") // e.g. "turn:10.200.11.42:3478"

	// TURN REST credentials (coturn use-auth-secret scheme): a short-lived
	// username (= expiry unix ts) + HMAC-SHA1 credential. Admin/surveillance only.
	app.Get("/api/v1/stream/turn", middleware.JWTAuth(issuer),
		middleware.RequirePermission(authz.PermCommandSurveillance), func(c *fiber.Ctx) error {
			ice := []fiber.Map{}
			if turnURL != "" {
				host := strings.TrimPrefix(turnURL, "turn:")
				ice = append(ice, fiber.Map{"urls": []string{"stun:" + host}})
				if turnSecret != "" {
					username := fmt.Sprintf("%d", time.Now().Add(time.Hour).Unix())
					mac := hmac.New(sha1.New, []byte(turnSecret))
					mac.Write([]byte(username))
					cred := base64.StdEncoding.EncodeToString(mac.Sum(nil))
					ice = append(ice, fiber.Map{
						"urls":       []string{turnURL, turnURL + "?transport=tcp"},
						"username":   username,
						"credential": cred,
					})
				}
			}
			return c.JSON(fiber.Map{"iceServers": ice})
		})

	// Signaling relay: /ws/signal?device_id=<uuid>. A device token registers as
	// its own device; an admin (surveillance perm) registers as a viewer of the
	// device_id it supplies. Routed per (tenant, device).
	app.Use("/ws/signal", func(c *fiber.Ctx) error {
		// Agent (OkHttp) sends "Bearer <jwt>"; browser sends "Bearer, <jwt>".
		claims, err := issuer.Parse(wsBearer(c.Get("Sec-WebSocket-Protocol")))
		if err != nil {
			return c.SendStatus(401)
		}
		role, deviceID := "viewer", c.Query("device_id")
		if claims.Kind == auth.KindDevice {
			role, deviceID = "device", claims.Subject
		} else if !authz.Can(claims.Role, authz.PermCommandSurveillance) {
			return c.SendStatus(403)
		}
		if deviceID == "" {
			return c.SendStatus(400)
		}
		c.Locals("role", role)
		c.Locals("key", claims.TenantID+"/"+deviceID)
		if websocket.IsWebSocketUpgrade(c) {
			return c.Next()
		}
		return c.SendStatus(fiber.StatusUpgradeRequired)
	})
	app.Get("/ws/signal", websocket.New(func(c *websocket.Conn) {
		role, _ := c.Locals("role").(string)
		key, _ := c.Locals("key").(string)
		cl := sigHub.Register(key, role, c)
		defer sigHub.Unregister(key, role, c)
		// Keepalive: ping every 10s so an idle relay socket isn't dropped (1006) by
		// a network intermediary while waiting for the peer's offer/answer. The
		// browser auto-responds with a pong, keeping the path warm both ways.
		stop := make(chan struct{})
		go func() {
			t := time.NewTicker(10 * time.Second)
			defer t.Stop()
			for {
				select {
				case <-stop:
					return
				case <-t.C:
					cl.Ping()
				}
			}
		}()
		defer close(stop)
		for {
			mt, data, err := c.ReadMessage()
			if err != nil {
				return
			}
			sigHub.Relay(key, role, mt, data)
		}
	}, wsCfg))

	go func() {
		mux := http.NewServeMux()
		mux.Handle("/metrics", promhttp.Handler())
		_ = (&http.Server{Addr: ":9100", Handler: mux, ReadHeaderTimeout: 5 * time.Second}).ListenAndServe()
	}()
	go func() {
		if err := app.Listen(":8006"); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal().Err(err).Msg("listen")
		}
	}()
	log.Info().Msg("notification-service started on :8006")
	<-ctx.Done()
	c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = app.ShutdownWithContext(c)
	mc.Disconnect(500)
}

// wsBearer extracts a JWT from a Sec-WebSocket-Protocol value. Browsers can only
// pass a token on a WS handshake as a subprotocol, and new WebSocket(url,
// ['Bearer', token]) serializes it to "Bearer, <jwt>" (comma) while native
// clients (OkHttp) send "Bearer <jwt>" (space). Both — and a bare token — reduce
// to the raw JWT.
func wsBearer(raw string) string {
	return strings.TrimLeft(strings.TrimSpace(strings.TrimPrefix(raw, "Bearer")), ", ")
}
