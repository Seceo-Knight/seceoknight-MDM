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
	"github.com/rs/zerolog/log"

	"github.com/mdm/alert-service/internal/handler"
	"github.com/mdm/alert-service/internal/store"
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

	issuer := auth.NewIssuer(cfg.JWTSecret, 15*time.Minute)
	s := store.New(pg)
	h := handler.New(s)

	app := fiber.New(fiber.Config{
		AppName: "mdm-alert", DisableStartupMessage: true,
		ReadTimeout: 15 * time.Second, WriteTimeout: 15 * time.Second,
	})
	app.Use(middleware.RequestLogger(), middleware.Recover(), middleware.Metrics(cfg.ServiceName))
	app.Get("/healthz", func(c *fiber.Ctx) error { return c.SendString("ok") })

	// Internal endpoint: service-to-service only, not exposed through nginx.
	// No auth required — Docker network trust.
	internal := app.Group("/internal")
	internal.Post("/notify", h.Notify)

	// Public API — requires JWT
	api := app.Group("/api/v1/alerts",
		middleware.JWTAuth(issuer),
		middleware.TenantScope(),
	)
	api.Get("/channels", middleware.RequirePermission(authz.PermPolicyRead), h.ListChannels)
	api.Post("/channels", middleware.RequirePermission(authz.PermPolicyWrite), h.CreateChannel)
	api.Get("/channels/:id", middleware.RequirePermission(authz.PermPolicyRead), h.GetChannel)
	api.Put("/channels/:id", middleware.RequirePermission(authz.PermPolicyWrite), h.UpdateChannel)
	api.Delete("/channels/:id", middleware.RequirePermission(authz.PermPolicyWrite), h.DeleteChannel)
	api.Post("/channels/:id/test", middleware.RequirePermission(authz.PermPolicyWrite), h.TestChannel)
	api.Get("/log", middleware.RequirePermission(authz.PermPolicyRead), h.ListLog)

	port := fmt.Sprintf(":%d", cfg.HTTPPort)
	go func() {
		if err := app.Listen(port); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal().Err(err).Msg("listen")
		}
	}()
	log.Info().Str("port", port).Msg("alert-service started")
	<-ctx.Done()
	c2, cancel2 := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel2()
	_ = app.ShutdownWithContext(c2)
}
