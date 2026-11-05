// device-service owns:
//   - the `devices`, `enrollment_tokens`, and `device_groups` tables;
//   - the public enrollment flow (POST /api/v1/enroll, GET /api/v1/enroll/qr);
//   - the device-facing /devices/me endpoints used by the agent (heartbeat,
//     state updates, policy retrieval handoff to policy-service);
//   - the admin-facing CRUD for devices.
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

	"github.com/mdm/device-service/internal/handlers"
	"github.com/mdm/device-service/internal/repository"
	"github.com/mdm/device-service/internal/service"
	"github.com/mdm/shared/auth"
	"github.com/mdm/shared/config"
	"github.com/mdm/shared/db"
	"github.com/mdm/shared/logger"
	"github.com/mdm/shared/authz"
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
		log.Fatal().Err(err).Msg("db connect")
	}
	defer pg.Close()

	bus, err := mq.Connect(cfg.NATSUrl)
	if err != nil {
		log.Fatal().Err(err).Msg("nats")
	}
	if err := bus.EnsureStreams(); err != nil {
		log.Warn().Err(err).Msg("nats streams")
	}

	issuer := auth.NewIssuer(cfg.JWTSecret, cfg.JWTAccessTTL)

	devRepo := repository.NewDeviceRepo(pg)
	tokRepo := repository.NewEnrollmentRepo(pg)
	groupRepo := repository.NewGroupRepo(pg)
	ttRepo := repository.NewTimeTravelRepo(pg)
	enrollSvc := service.NewEnrollmentService(devRepo, tokRepo, pg, issuer, bus, cfg.PublicBaseURL, cfg.JWTRefreshTTL)
	deviceSvc := service.NewDeviceService(devRepo, bus)
	groupSvc := service.NewGroupService(groupRepo, bus)

	enrollH := handlers.NewEnrollmentHandler(enrollSvc)
	deviceH := handlers.NewDeviceHandler(deviceSvc)
	groupH := handlers.NewGroupHandler(groupSvc)
	ttH := handlers.NewTimeTravelHandler(ttRepo)

	app := fiber.New(fiber.Config{
		AppName:               "mdm-device",
		DisableStartupMessage: true,
		ReadTimeout:           20 * time.Second,
		WriteTimeout:          20 * time.Second,
	})
	app.Use(middleware.RequestLogger(), middleware.Recover(), middleware.Metrics(cfg.ServiceName))

	app.Get("/healthz", func(c *fiber.Ctx) error { return c.SendString("ok") })

	// Public enrollment endpoints (no auth — gated by the token in the body).
	en := app.Group("/api/v1/enroll")
	en.Post("/", enrollH.Enroll)               // device exchanges enrollment token for credentials
	en.Get("/qr/:tokenID", enrollH.QRPayload)  // returns the JSON payload encoded in the QR

	// Admin endpoints (user JWT).
	admin := app.Group("/api/v1", middleware.JWTAuth(issuer), middleware.TenantScope())
	admin.Post("/enroll/tokens", middleware.RequirePermission(authz.PermEnrollCreate), enrollH.CreateToken)
	// Provisioning config (APK URL, signature checksum, DPC component, WiFi) —
	// admin/super_admin only (they hold enroll:create).
	admin.Get("/enroll/config", middleware.RequirePermission(authz.PermEnrollCreate), enrollH.GetConfig)
	admin.Put("/enroll/config", middleware.RequirePermission(authz.PermEnrollCreate), enrollH.SaveConfig)
	// Global (cross-tenant) platform settings — the debug-unlock password.
	// admin/super_admin only (platform:manage). Hosted here (not a new service)
	// so it rides the already-routed /api/v1/enroll prefix and the device-facing
	// delivery (enroll + heartbeat) reads it from the same DB.
	admin.Get("/enroll/platform-settings", middleware.RequirePermission(authz.PermPlatformManage), enrollH.GetPlatformSettings)
	admin.Put("/enroll/platform-settings", middleware.RequirePermission(authz.PermPlatformManage), enrollH.SavePlatformSettings)
	admin.Get("/devices", middleware.RequirePermission(authz.PermDeviceRead), deviceH.List)
	admin.Get("/devices/:id", middleware.RequirePermission(authz.PermDeviceRead), deviceH.Get)
	admin.Get("/devices/:id/posture", middleware.RequirePermission(authz.PermDeviceRead), deviceH.Posture)
	admin.Patch("/devices/:id", middleware.RequirePermission(authz.PermDeviceUpdate), deviceH.Update)
	admin.Delete("/devices/:id", middleware.RequirePermission(authz.PermDeviceRetire), deviceH.Retire)

	// Device groups (classification). Read for any role; mutations need group:manage.
	// Fleet time-travel — reconstruct past fleet/device state from the
	// append-only snapshot history + audit log.
	admin.Get("/timetravel/fleet", middleware.RequirePermission(authz.PermDeviceRead), ttH.Fleet)
	admin.Get("/timetravel/device/:id", middleware.RequirePermission(authz.PermDeviceRead), ttH.Device)

	admin.Get("/groups", middleware.RequirePermission(authz.PermGroupRead), groupH.List)
	admin.Post("/groups", middleware.RequirePermission(authz.PermGroupManage), groupH.Create)
	admin.Patch("/groups/:id", middleware.RequirePermission(authz.PermGroupManage), groupH.Update)
	admin.Delete("/groups/:id", middleware.RequirePermission(authz.PermGroupManage), groupH.Delete)

	// Device endpoints (device JWT).
	dev := app.Group("/api/v1/devices/me", middleware.JWTAuth(issuer), middleware.RequireDevice())
	dev.Post("/heartbeat", deviceH.Heartbeat)
	dev.Patch("/info", deviceH.UpdateSelfInfo)
	// Device reports its own removal (Dev Console "remove agent") — soft-retires
	// this device. Acts on the device's own JWT identity, so no admin permission.
	dev.Post("/unenroll", deviceH.SelfUnenroll)

	go func() {
		mux := http.NewServeMux()
		mux.Handle("/metrics", promhttp.Handler())
		_ = (&http.Server{Addr: ":9100", Handler: mux, ReadHeaderTimeout: 5 * time.Second}).ListenAndServe()
	}()

	go func() {
		if err := app.Listen(":8002"); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal().Err(err).Msg("listen")
		}
	}()
	log.Info().Msg("device-service started on :8002")

	<-ctx.Done()
	c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = app.ShutdownWithContext(c)
}
