// auth-service: issues, refreshes, and revokes tokens for admin users and
// enrolled devices. Owns the users + refresh_tokens tables.
package main

import (
	"context"
	"errors"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jmoiron/sqlx"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"

	"github.com/mdm/auth-service/internal/handlers"
	"github.com/mdm/auth-service/internal/repository"
	"github.com/mdm/auth-service/internal/service"
	"github.com/mdm/shared/auth"
	"github.com/mdm/shared/cache"
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

	rdb := cache.New(cfg.RedisAddr)
	defer rdb.Close()

	issuer := auth.NewIssuer(cfg.JWTSecret, cfg.JWTAccessTTL)

	// Best-effort NATS for audit emission (user/role management). A nil bus is
	// tolerated by events.Emit, so auth still works if NATS is down.
	bus, err := mq.Connect(cfg.NATSUrl)
	if err != nil {
		log.Warn().Err(err).Msg("nats connect — user-management audit events will be dropped")
	}

	app := newApp(cfg.ServiceName, pg, rdb, issuer, cfg.JWTRefreshTTL, bus)

	// Prometheus on a separate port to keep it off the public path.
	go func() {
		mux := http.NewServeMux()
		mux.Handle("/metrics", promhttp.Handler())
		srv := &http.Server{Addr: ":9100", Handler: mux, ReadHeaderTimeout: 5 * time.Second}
		_ = srv.ListenAndServe()
	}()

	addr := ":" + itoa(cfg.HTTPPort)
	go func() {
		if err := app.Listen(addr); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal().Err(err).Msg("listen")
		}
	}()
	log.Info().Str("addr", addr).Msg("auth-service started")

	<-ctx.Done()
	log.Info().Msg("shutdown signal received")
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	_ = app.ShutdownWithContext(shutdownCtx)
}

func newApp(svc string, pg *sqlx.DB, rdb *redis.Client, issuer *auth.Issuer, refreshTTL time.Duration, bus *mq.Bus) *fiber.App {
	app := fiber.New(fiber.Config{
		AppName:               "mdm-auth",
		DisableStartupMessage: true,
		ReadTimeout:           15 * time.Second,
		WriteTimeout:          15 * time.Second,
		// Requests arrive via the nginx gateway, so the raw peer is always the
		// proxy's container IP (172.x). Read the REAL client IP from the
		// X-Forwarded-For header nginx sets (proxy.inc) — this is what fills the
		// Access Log's session/login IP. EnableTrustedProxyCheck means XFF is only
		// honoured when the connecting peer is a trusted proxy (the docker/LAN
		// ranges below), so an external client can't spoof its own IP.
		// TrustedProxies = ONLY the gateway's own range (the docker bridge nginx
		// sits on) + loopback. It must NOT include the client LAN (10.200.x):
		// Fiber discards any XFF entry that is itself a trusted proxy, so trusting
		// the client subnet would make it throw away the real client IP and fall
		// back to the proxy address — the very bug we're fixing.
		ProxyHeader:             fiber.HeaderXForwardedFor,
		EnableTrustedProxyCheck: true,
		TrustedProxies:          []string{"127.0.0.1", "::1", "172.16.0.0/12"},
	})

	app.Use(middleware.RequestLogger())
	app.Use(middleware.Recover())
	app.Use(middleware.Metrics(svc))

	userRepo := repository.NewUserRepo(pg)
	refreshRepo := repository.NewRefreshRepo(pg)

	authSvc := service.NewAuthService(userRepo, refreshRepo, issuer, refreshTTL, bus, rdb)
	authH := handlers.NewAuthHandler(authSvc)

	app.Get("/healthz", func(c *fiber.Ctx) error { return c.SendString("ok") })
	app.Get("/readyz", func(c *fiber.Ctx) error {
		if err := pg.PingContext(c.Context()); err != nil {
			return c.Status(503).SendString("postgres down")
		}
		return c.SendString("ok")
	})

	v1 := app.Group("/api/v1/auth")
	v1.Post("/login", authH.Login)
	v1.Post("/refresh", authH.Refresh)
	v1.Post("/logout", authH.Logout)
	v1.Get("/me", middleware.JWTAuth(issuer), authH.Me)
	v1.Patch("/me", middleware.JWTAuth(issuer), authH.UpdateProfile)
	v1.Post("/change-password", middleware.JWTAuth(issuer), authH.ChangePassword)
	v1.Get("/roles", middleware.JWTAuth(issuer), middleware.RequirePermission(authz.PermRoleRead), authH.Roles)
	v1.Get("/users", middleware.JWTAuth(issuer), middleware.RequirePermission(authz.PermUserRead), authH.Users)
	v1.Post("/users", middleware.JWTAuth(issuer), middleware.RequirePermission(authz.PermUserManage), authH.CreateUser)
	v1.Patch("/users/:id/role", middleware.JWTAuth(issuer), middleware.RequirePermission(authz.PermUserManage), authH.UpdateUserRole)
	v1.Post("/users/:id/deactivate", middleware.JWTAuth(issuer), middleware.RequirePermission(authz.PermUserManage), authH.DeactivateUser)
	// Access Log — active admin sessions + force-logout. Read gated to user:read,
	// revoke to user:manage (admin / super_admin).
	v1.Get("/sessions", middleware.JWTAuth(issuer), middleware.RequirePermission(authz.PermUserRead), authH.Sessions)
	v1.Post("/sessions/:id/revoke", middleware.JWTAuth(issuer), middleware.RequirePermission(authz.PermUserManage), authH.RevokeSession)

	return app
}

func itoa(i int) string {
	const digits = "0123456789"
	if i == 0 {
		return "0"
	}
	b := make([]byte, 0, 5)
	for i > 0 {
		b = append([]byte{digits[i%10]}, b...)
		i /= 10
	}
	return string(b)
}
