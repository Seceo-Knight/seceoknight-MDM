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

	"github.com/mdm/file-service/internal/handlers"
	"github.com/mdm/file-service/internal/repository"
	"github.com/mdm/file-service/internal/storage"
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

	store, err := storage.New(cfg.MinioEndpoint, cfg.MinioPublicEndpoint, cfg.MinioAccessKey, cfg.MinioSecretKey, false)
	if err != nil {
		log.Fatal().Err(err).Msg("minio")
	}
	_ = store.EnsureBucket(ctx)

	issuer := auth.NewIssuer(cfg.JWTSecret, cfg.JWTAccessTTL)
	repo := repository.NewFileRepo(pg)
	h := handlers.New(repo, store)

	app := fiber.New(fiber.Config{
		AppName: "mdm-file", DisableStartupMessage: true,
		BodyLimit:    256 << 20, // 256 MB for APKs
		ReadTimeout:  10 * time.Minute,
		WriteTimeout: 10 * time.Minute,
	})
	app.Use(middleware.RequestLogger(), middleware.Recover(), middleware.Metrics(cfg.ServiceName))
	app.Get("/healthz", func(c *fiber.Ctx) error { return c.SendString("ok") })
	// Public endpoint — no JWT required. Android Setup Wizard calls this during
	// QR provisioning before the device has any auth token. Tenant is in ?tenant=.
	app.Get("/api/v1/files/agent/latest.apk", h.LatestAgentAPK)

	g := app.Group("/api/v1/files", middleware.JWTAuth(issuer), middleware.TenantScope())
	g.Get("/", middleware.RequirePermission(authz.PermFileRead), h.List)
	g.Post("/upload", middleware.RequirePermission(authz.PermFileWrite), h.Upload)
	g.Post("/device-upload", middleware.RequireDevice(), h.DeviceUpload)
	g.Get("/audio/session/:sessionID/url", middleware.RequirePermission(authz.PermFileRead), h.SessionAudio)
	// Devices presign-download their own self-update APK here, so allow a device
	// token too (tenant-scoped) — not just an admin user.
	g.Get("/:id/url", middleware.RequirePermissionOrDevice(authz.PermFileRead), h.Presign)
	g.Delete("/audio/session/:sessionID", middleware.RequirePermission(authz.PermFileDelete), h.DeleteSession)
	g.Delete("/:id", middleware.RequirePermission(authz.PermFileDelete), h.Delete)

	go func() {
		mux := http.NewServeMux()
		mux.Handle("/metrics", promhttp.Handler())
		_ = (&http.Server{Addr: ":9100", Handler: mux, ReadHeaderTimeout: 5 * time.Second}).ListenAndServe()
	}()
	go func() {
		if err := app.Listen(":8007"); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal().Err(err).Msg("listen")
		}
	}()
	log.Info().Msg("file-service started on :8007")
	<-ctx.Done()
	c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = app.ShutdownWithContext(c)
}
