package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/nats-io/nats.go"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/rs/zerolog/log"

	"github.com/mdm/audit-service/internal/handlers"
	"github.com/mdm/audit-service/internal/repository"
	"github.com/mdm/shared/auth"
	"github.com/mdm/shared/authz"
	"github.com/mdm/shared/config"
	"github.com/mdm/shared/db"
	"github.com/mdm/shared/logger"
	"github.com/mdm/shared/middleware"
	"github.com/mdm/shared/models"
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

	pg, err := db.Open(ctx, cfg.PostgresDSN)
	if err != nil {
		log.Fatal().Err(err).Msg("db")
	}
	defer pg.Close()

	bus, err := mq.Connect(cfg.NATSUrl)
	if err != nil {
		log.Fatal().Err(err).Msg("nats")
	}
	_ = bus.EnsureStreams()

	repo := repository.NewAuditRepo(pg)
	issuer := auth.NewIssuer(cfg.JWTSecret, cfg.JWTAccessTTL)
	h := handlers.New(repo)

	// Consume NATS audit subjects from other services so they can emit fire-
	// and-forget events without HTTP round trips.
	go consumeAudit(ctx, bus.JS, repo)

	app := fiber.New(fiber.Config{
		AppName: "mdm-audit", DisableStartupMessage: true,
		ReadTimeout: 20 * time.Second, WriteTimeout: 20 * time.Second,
	})
	app.Use(middleware.RequestLogger(), middleware.Recover(), middleware.Metrics(cfg.ServiceName))
	app.Get("/healthz", func(c *fiber.Ctx) error { return c.SendString("ok") })

	g := app.Group("/api/v1/audit", middleware.JWTAuth(issuer), middleware.TenantScope())
	g.Get("/", middleware.RequirePermission(authz.PermAuditRead), h.List)
	g.Post("/", middleware.RequirePermission(authz.PermAuditWrite), h.Append)

	go func() {
		mux := http.NewServeMux()
		mux.Handle("/metrics", promhttp.Handler())
		_ = (&http.Server{Addr: ":9100", Handler: mux, ReadHeaderTimeout: 5 * time.Second}).ListenAndServe()
	}()
	go func() {
		if err := app.Listen(":8008"); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal().Err(err).Msg("listen")
		}
	}()
	log.Info().Msg("audit-service started on :8008")
	<-ctx.Done()
	c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = app.ShutdownWithContext(c)
}

func consumeAudit(ctx context.Context, js nats.JetStreamContext, repo *repository.AuditRepo) {
	_, err := js.Subscribe("mdm.audit.>", func(m *nats.Msg) {
		var env struct {
			TenantID   string          `json:"tenant_id"`
			ActorID    *string         `json:"actor_id,omitempty"`
			ActorKind  string          `json:"actor_kind"`
			Action     string          `json:"action"`
			TargetKind *string         `json:"target_kind,omitempty"`
			TargetID   *string         `json:"target_id,omitempty"`
			Metadata   json.RawMessage `json:"metadata,omitempty"`
		}
		if err := json.Unmarshal(m.Data, &env); err != nil {
			_ = m.Ack()
			return
		}
		tID, _ := uuid.Parse(env.TenantID)
		entry := &models.AuditEntry{TenantID: tID, ActorKind: env.ActorKind, Action: env.Action}
		if env.ActorID != nil {
			a, err := uuid.Parse(*env.ActorID)
			if err == nil {
				entry.ActorID = &a
			}
		}
		if env.TargetID != nil {
			t, err := uuid.Parse(*env.TargetID)
			if err == nil {
				entry.TargetID = &t
			}
		}
		entry.TargetKind = env.TargetKind
		if env.Metadata == nil {
			entry.Metadata = json.RawMessage(`{}`)
		} else {
			entry.Metadata = env.Metadata
		}
		if err := repo.Append(ctx, entry); err != nil {
			log.Error().Err(err).Msg("audit append from nats")
		}
		_ = m.Ack()
	}, nats.AckExplicit(), nats.Durable("audit-consumer"))
	if err != nil {
		log.Error().Err(err).Msg("nats subscribe audit")
	}
	<-ctx.Done()
}
