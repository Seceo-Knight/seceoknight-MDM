package main

import (
	"context"
	"errors"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/rs/zerolog/log"

	"github.com/mdm/shared/auth"
	"github.com/mdm/shared/authz"
	"github.com/mdm/shared/config"
	"github.com/mdm/shared/db"
	"github.com/mdm/shared/logger"
	"github.com/mdm/shared/middleware"
	"github.com/mdm/telemetry-service/internal/handlers"
	"github.com/mdm/telemetry-service/internal/repository"
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

	issuer := auth.NewIssuer(cfg.JWTSecret, cfg.JWTAccessTTL)
	repo := repository.NewTelemetryRepo(pg)
	h := handlers.New(repo)

	app := fiber.New(fiber.Config{
		AppName: "mdm-telemetry", DisableStartupMessage: true,
		BodyLimit:    8 << 20, // 8 MB batches
		ReadTimeout:  30 * time.Second, WriteTimeout: 30 * time.Second,
	})
	app.Use(middleware.RequestLogger(), middleware.Recover(), middleware.Metrics(cfg.ServiceName))
	app.Get("/healthz", func(c *fiber.Ctx) error { return c.SendString("ok") })

	// IMPORTANT: do NOT use app.Group(prefix, mws...) here. Fiber implements
	// group middleware via app.Use(prefix, mws...) under the hood, which is
	// path-bound — so registering a "dev" group at /api/v1/telemetry with
	// RequireDevice would force EVERY route under that prefix (including the
	// admin GETs) through RequireDevice, rejecting admin tokens with
	// "device token required". That's what made the Activity tab look empty
	// even though events were landing in the DB.
	//
	// Per-route middleware avoids the path-bound Use trap entirely.
	app.Post("/api/v1/telemetry/ingest",
		middleware.JWTAuth(issuer), middleware.RequireDevice(), middleware.TenantScope(),
		h.Ingest)
	app.Get("/api/v1/telemetry/devices/:deviceID/latest",
		middleware.JWTAuth(issuer), middleware.TenantScope(), middleware.RequirePermission(authz.PermTelemetryRead),
		h.Latest)
	app.Get("/api/v1/telemetry/devices/:deviceID/events",
		middleware.JWTAuth(issuer), middleware.TenantScope(), middleware.RequirePermission(authz.PermTelemetryRead),
		h.Events)

	go func() {
		mux := http.NewServeMux()
		mux.Handle("/metrics", promhttp.Handler())
		_ = (&http.Server{Addr: ":9100", Handler: mux, ReadHeaderTimeout: 5 * time.Second}).ListenAndServe()
	}()
	go func() {
		if err := app.Listen(":8005"); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal().Err(err).Msg("listen")
		}
	}()
	log.Info().Msg("telemetry-service started on :8005")
	<-ctx.Done()
	c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = app.ShutdownWithContext(c)
}
