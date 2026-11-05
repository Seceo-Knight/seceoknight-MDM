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

	"github.com/mdm/policy-service/internal/handlers"
	"github.com/mdm/policy-service/internal/repository"
	"github.com/mdm/policy-service/internal/service"
	"github.com/mdm/shared/auth"
	"github.com/mdm/shared/authz"
	"github.com/mdm/shared/config"
	"github.com/mdm/shared/db"
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

	pg, err := db.Open(ctx, cfg.PostgresDSN)
	if err != nil {
		log.Fatal().Err(err).Msg("db")
	}
	defer pg.Close()

	issuer := auth.NewIssuer(cfg.JWTSecret, cfg.JWTAccessTTL)
	repo := repository.NewPolicyRepo(pg)
	bus, err := mq.Connect(cfg.NATSUrl)
	if err != nil {
		log.Warn().Err(err).Msg("nats connect — audit events will be dropped")
	}
	svc := service.NewPolicyService(repo, bus)
	h := handlers.NewPolicyHandler(svc)

	app := fiber.New(fiber.Config{
		AppName: "mdm-policy", DisableStartupMessage: true,
		ReadTimeout: 20 * time.Second, WriteTimeout: 20 * time.Second,
	})
	app.Use(middleware.RequestLogger(), middleware.Recover(), middleware.Metrics(cfg.ServiceName))

	app.Get("/healthz", func(c *fiber.Ctx) error { return c.SendString("ok") })

	// IMPORTANT: register the device-facing /assigned route BEFORE the
	// admin group's "/:id" catch-all is registered. Fiber matches routes
	// in declaration order, and "/:id" happily consumes the literal
	// segment "assigned" — sending the request into h.Get, which then
	// returns 400 on the failed uuid.Parse. That bug made every device-
	// side policy fetch fail silently for months: APPLY_POLICY commands
	// completed with empty result {} because the agent never got the spec.
	app.Get("/api/v1/policies/assigned",
		middleware.JWTAuth(issuer), middleware.RequireDevice(), middleware.TenantScope(), h.AssignedForDevice)

	admin := app.Group("/api/v1/policies", middleware.JWTAuth(issuer), middleware.TenantScope())
	admin.Get("/", middleware.RequirePermission(authz.PermPolicyRead), h.List)
	admin.Post("/", middleware.RequirePermission(authz.PermPolicyWrite), h.Upsert)
	admin.Get("/resolved-for/:deviceID", middleware.RequirePermission(authz.PermPolicyRead), h.ResolvedForDevice)
	admin.Get("/for-device/:deviceID", middleware.RequirePermission(authz.PermPolicyRead), h.AssignmentsForDevice)
	admin.Get("/:id", middleware.RequirePermission(authz.PermPolicyRead), h.Get)
	admin.Get("/:id/diff", middleware.RequirePermission(authz.PermPolicyRead), h.Diff)
	admin.Get("/:id/assignments", middleware.RequirePermission(authz.PermPolicyRead), h.ListAssignments)
	admin.Post("/:id/versions", middleware.RequirePermission(authz.PermPolicyWrite), h.Upsert)
	admin.Delete("/:id", middleware.RequirePermission(authz.PermPolicyWrite), h.Delete)
	admin.Post("/assign", middleware.RequirePermission(authz.PermPolicyAssign), h.Assign)
	admin.Post("/unassign", middleware.RequirePermission(authz.PermPolicyAssign), h.Unassign)

	go func() {
		mux := http.NewServeMux()
		mux.Handle("/metrics", promhttp.Handler())
		_ = (&http.Server{Addr: ":9100", Handler: mux, ReadHeaderTimeout: 5 * time.Second}).ListenAndServe()
	}()

	go func() {
		if err := app.Listen(":8003"); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal().Err(err).Msg("listen")
		}
	}()
	log.Info().Msg("policy-service started on :8003")
	<-ctx.Done()
	c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = app.ShutdownWithContext(c)
}
