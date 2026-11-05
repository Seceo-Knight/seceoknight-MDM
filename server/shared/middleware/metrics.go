package middleware

import (
	"strconv"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	requests = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "mdm_http_requests_total",
		Help: "Total HTTP requests processed",
	}, []string{"service", "method", "path", "status"})

	duration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "mdm_http_request_duration_seconds",
		Help:    "Request duration in seconds",
		Buckets: prometheus.DefBuckets,
	}, []string{"service", "method", "path"})
)

func Metrics(service string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		start := time.Now()
		err := c.Next()
		path := c.Route().Path
		if path == "" {
			path = c.Path()
		}
		duration.WithLabelValues(service, c.Method(), path).Observe(time.Since(start).Seconds())
		requests.WithLabelValues(service, c.Method(), path, strconv.Itoa(c.Response().StatusCode())).Inc()
		return err
	}
}
