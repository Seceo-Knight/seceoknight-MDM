module github.com/mdm/audit-service

go 1.22

require (
	github.com/gofiber/fiber/v2 v2.52.5
	github.com/google/uuid v1.6.0
	github.com/jmoiron/sqlx v1.4.0
	github.com/mdm/shared v0.0.0
	github.com/nats-io/nats.go v1.36.0
	github.com/prometheus/client_golang v1.20.4
	github.com/rs/zerolog v1.33.0
)

replace github.com/mdm/shared => ../shared
