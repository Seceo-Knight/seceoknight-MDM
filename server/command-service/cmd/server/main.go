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

	"github.com/mdm/command-service/internal/handlers"
	"github.com/mdm/command-service/internal/notify"
	"github.com/mdm/command-service/internal/repository"
	"github.com/mdm/command-service/internal/service"
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
	repo := repository.NewCommandRepo(pg)
	bus, err := mq.Connect(cfg.NATSUrl)
	if err != nil {
		log.Warn().Err(err).Msg("nats connect — audit events will be dropped")
	}
	notifier := notify.New()
	svc := service.NewCommandService(repo, bus, notifier)
	h := handlers.NewCommandHandler(svc)

	// Command delivery is now HTTP long-poll (svc.Poll holds the request open and
	// notifier wakes it on Create) — the MQTT push dispatcher is retired because
	// the long-lived broker socket was unreliable on OEM devices. All that's left
	// of the old dispatcher is the periodic timeout reaper below.
	go func() {
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if n, err := repo.TimeoutOverdue(ctx, time.Now()); err == nil && n > 0 {
					log.Info().Int64("count", n).Msg("commands timed out")
				}
			}
		}
	}()

	app := fiber.New(fiber.Config{
		AppName: "mdm-command", DisableStartupMessage: true,
		// Generous timeouts: GET /commands/poll holds open up to ~20-30s
		// (long-poll), so the write deadline must comfortably exceed that.
		ReadTimeout: 45 * time.Second, WriteTimeout: 45 * time.Second,
	})
	app.Use(middleware.RequestLogger(), middleware.Recover(), middleware.Metrics(cfg.ServiceName))
	app.Get("/healthz", func(c *fiber.Ctx) error { return c.SendString("ok") })

	admin := app.Group("/api/v1/commands", middleware.JWTAuth(issuer), middleware.TenantScope())
	// Baseline gate: any role that can issue commands at all (operator+). The
	// per-command-kind risk tier (basic / privileged / surveillance) is then
	// enforced inside the handler via authz.CommandPermission — so an operator
	// can LOCK/locate but not WIPE or start a covert audio stream.
	admin.Post("/", middleware.RequirePermission(authz.PermCommandBasic), h.Create)
	admin.Post("/broadcast", middleware.RequirePermission(authz.PermCommandBasic), h.Broadcast)

	// Device (device-token) endpoints. IMPORTANT: the static GET /poll route must
	// be registered BEFORE the admin "GET /:id" param route below. Fiber matches
	// routes in registration order, so if "/:id" comes first it captures
	// "/commands/poll" (id="poll") and runs the admin RequirePermission middleware,
	// which only accepts USER tokens — so a device token gets a hard 403 and the
	// poll fallback silently dies (commands then only arrive over MQTT, and time
	// out whenever MQTT is flapping). Keep /poll ahead of /:id.
	dev := app.Group("/api/v1/commands", middleware.JWTAuth(issuer))
	dev.Get("/poll", middleware.RequireDevice(), h.Poll)
	dev.Post("/:id/ack", middleware.RequireDevice(), h.Ack)
	dev.Post("/:id/result", middleware.RequireDevice(), h.Result)

	admin.Get("/:id", middleware.RequirePermission(authz.PermCommandRead), h.Get)
	admin.Get("/by-device/:deviceID", middleware.RequirePermission(authz.PermCommandRead), h.ListForDevice)

	go func() {
		mux := http.NewServeMux()
		mux.Handle("/metrics", promhttp.Handler())
		_ = (&http.Server{Addr: ":9100", Handler: mux, ReadHeaderTimeout: 5 * time.Second}).ListenAndServe()
	}()
	go func() {
		if err := app.Listen(":8004"); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal().Err(err).Msg("listen")
		}
	}()
	log.Info().Msg("command-service started on :8004")
	<-ctx.Done()
	c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = app.ShutdownWithContext(c)
}
