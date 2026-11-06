package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/rs/zerolog/log"

	"github.com/mdm/compliance-service/internal/engine"
	"github.com/mdm/compliance-service/internal/handler"
	"github.com/mdm/compliance-service/internal/store"
	"github.com/mdm/shared/auth"
	"github.com/mdm/shared/authz"
	"github.com/mdm/shared/config"
	"github.com/mdm/shared/db"
	"github.com/mdm/shared/logger"
	"github.com/mdm/shared/middleware"
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

	issuer := auth.NewIssuer(cfg.JWTSecret, 5*time.Minute)
	s := store.New(pg)
	h := handler.New(s)

	commandURL := getenv("COMMAND_SERVICE_URL", "http://command-service:8004")
	eng := engine.New(s, issuer, commandURL)
	go eng.Run(ctx)

	app := fiber.New(fiber.Config{
		AppName: "mdm-compliance", DisableStartupMessage: true,
		ReadTimeout: 15 * time.Second, WriteTimeout: 15 * time.Second,
	})
	app.Use(middleware.RequestLogger(), middleware.Recover(), middleware.Metrics(cfg.ServiceName))
	app.Get("/healthz", func(c *fiber.Ctx) error { return c.SendString("ok") })

	api := app.Group("/api/v1/compliance",
		middleware.JWTAuth(issuer),
		middleware.TenantScope(),
	)

	// Rules CRUD — require at least policy:write (admin + operator)
	api.Get("/rules", middleware.RequirePermission(authz.PermPolicyRead), h.ListRules)
	api.Post("/rules", middleware.RequirePermission(authz.PermPolicyWrite), h.CreateRule)
	api.Put("/rules/:id", middleware.RequirePermission(authz.PermPolicyWrite), h.UpdateRule)
	api.Delete("/rules/:id", middleware.RequirePermission(authz.PermPolicyWrite), h.DeleteRule)

	// Events log — readable by anyone who can read commands/policies
	api.Get("/events", middleware.RequirePermission(authz.PermCommandRead), h.ListEvents)

	// Geofences — virtual geographic boundaries with auto-enforcement actions
	api.Get("/geofences",           middleware.RequirePermission(authz.PermPolicyRead),  h.ListGeofences)
	api.Post("/geofences",          middleware.RequirePermission(authz.PermPolicyWrite), h.CreateGeofence)
	api.Put("/geofences/:id",       middleware.RequirePermission(authz.PermPolicyWrite), h.UpdateGeofence)
	api.Delete("/geofences/:id",    middleware.RequirePermission(authz.PermPolicyWrite), h.DeleteGeofence)
	api.Get("/geofences/events",    middleware.RequirePermission(authz.PermPolicyRead),  h.ListGeofenceEvents)

	// Package blocklist — fleet-wide app block management
	api.Get("/blocklist",         middleware.RequirePermission(authz.PermPolicyRead),  h.ListBlockedPackages)
	api.Post("/blocklist",        middleware.RequirePermission(authz.PermPolicyWrite), h.AddBlockedPackage)
	api.Delete("/blocklist/:id",  middleware.RequirePermission(authz.PermPolicyWrite), h.DeleteBlockedPackage)

	go func() {
		mux := http.NewServeMux()
		mux.Handle("/metrics", promhttp.Handler())
		_ = (&http.Server{Addr: ":9100", Handler: mux, ReadHeaderTimeout: 5 * time.Second}).ListenAndServe()
	}()

	port := fmt.Sprintf(":%d", cfg.HTTPPort)
	go func() {
		if err := app.Listen(port); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal().Err(err).Msg("listen")
		}
	}()
	log.Info().Str("port", port).Msg("compliance-service started")
	<-ctx.Done()
	c2, cancel2 := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel2()
	_ = app.ShutdownWithContext(c2)
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
