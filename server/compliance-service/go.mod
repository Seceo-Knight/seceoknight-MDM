module github.com/mdm/compliance-service

go 1.22

replace github.com/mdm/shared => ../shared

require (
	github.com/gofiber/fiber/v2 v2.52.5
	github.com/google/uuid v1.6.0
	github.com/jmoiron/sqlx v1.3.5
	github.com/lib/pq v1.10.9
	github.com/mdm/shared v0.0.0
	github.com/prometheus/client_golang v1.19.1
	github.com/rs/zerolog v1.32.0
)
