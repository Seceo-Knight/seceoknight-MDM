// Package config loads service configuration from environment variables.
// All services share the same conventions; service-specific knobs live alongside
// the service in question.
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

type Config struct {
	ServiceName string
	Env         string
	LogLevel    string
	HTTPPort    int

	PostgresDSN string
	RedisAddr   string
	NATSUrl     string

	MQTTBroker string
	MQTTUser   string
	MQTTPass   string

	MinioEndpoint       string
	MinioPublicEndpoint string // browser-reachable presign host (e.g. "localhost:9000")
	MinioAccessKey      string
	MinioSecretKey      string

	JWTSecret     string
	JWTAccessTTL  time.Duration
	JWTRefreshTTL time.Duration

	PublicBaseURL string
}

func Load() (Config, error) {
	c := Config{
		ServiceName:    getenv("SERVICE_NAME", "mdm-service"),
		Env:            getenv("ENV", "development"),
		LogLevel:       getenv("LOG_LEVEL", "info"),
		PostgresDSN:    getenv("POSTGRES_DSN", ""),
		RedisAddr:      getenv("REDIS_ADDR", "redis:6379"),
		NATSUrl:        getenv("NATS_URL", "nats://nats:4222"),
		MQTTBroker:     getenv("MQTT_BROKER", "tcp://mosquitto:1883"),
		MQTTUser:       getenv("MQTT_USER", "mdm"),
		MQTTPass:       getenv("MQTT_PASS", "mdmpass"),
		MinioEndpoint:       getenv("MINIO_ENDPOINT", "minio:9000"),
		MinioPublicEndpoint: getenv("MINIO_PUBLIC_ENDPOINT", "localhost:9000"),
		MinioAccessKey:      getenv("MINIO_ACCESS_KEY", "minioadmin"),
		MinioSecretKey:      getenv("MINIO_SECRET_KEY", "minioadmin"),
		JWTSecret:      getenv("JWT_SECRET", ""),
		PublicBaseURL:  getenv("PUBLIC_BASE_URL", "http://localhost"),
	}

	port, _ := strconv.Atoi(getenv("HTTP_PORT", "8000"))
	c.HTTPPort = port

	at, err := time.ParseDuration(getenv("JWT_ACCESS_TTL", "15m"))
	if err != nil {
		return c, fmt.Errorf("JWT_ACCESS_TTL: %w", err)
	}
	c.JWTAccessTTL = at

	rt, err := time.ParseDuration(getenv("JWT_REFRESH_TTL", "168h"))
	if err != nil {
		return c, fmt.Errorf("JWT_REFRESH_TTL: %w", err)
	}
	c.JWTRefreshTTL = rt

	if c.JWTSecret == "" || len(c.JWTSecret) < 32 {
		return c, fmt.Errorf("JWT_SECRET must be set and >= 32 bytes")
	}
	if c.PostgresDSN == "" {
		return c, fmt.Errorf("POSTGRES_DSN required")
	}

	return c, nil
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
