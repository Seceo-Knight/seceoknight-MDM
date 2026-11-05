module github.com/mdm/notification-service

go 1.22

require (
	github.com/eclipse/paho.mqtt.golang v1.4.3
	github.com/gofiber/contrib/websocket v1.3.4
	github.com/gofiber/fiber/v2 v2.52.6
	github.com/google/uuid v1.6.0
	github.com/mdm/shared v0.0.0
	github.com/nats-io/nats.go v1.36.0
	github.com/prometheus/client_golang v1.20.4
	github.com/rs/zerolog v1.33.0
)

require (
	github.com/andybalholm/brotli v1.1.0 // indirect
	github.com/beorn7/perks v1.0.1 // indirect
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/fasthttp/websocket v1.5.8 // indirect
	github.com/golang-jwt/jwt/v5 v5.2.1 // indirect
	github.com/gorilla/websocket v1.5.0 // indirect
	github.com/klauspost/compress v1.17.9 // indirect
	github.com/mattn/go-colorable v0.1.13 // indirect
	github.com/mattn/go-isatty v0.0.20 // indirect
	github.com/mattn/go-runewidth v0.0.16 // indirect
	github.com/munnerz/goautoneg v0.0.0-20191010083416-a7dc8b61c822 // indirect
	github.com/nats-io/nkeys v0.4.7 // indirect
	github.com/nats-io/nuid v1.0.1 // indirect
	github.com/prometheus/client_model v0.6.1 // indirect
	github.com/prometheus/common v0.55.0 // indirect
	github.com/prometheus/procfs v0.15.1 // indirect
	github.com/rivo/uniseg v0.2.0 // indirect
	github.com/savsgio/gotils v0.0.0-20240303185622-093b76447511 // indirect
	github.com/valyala/bytebufferpool v1.0.0 // indirect
	github.com/valyala/fasthttp v1.52.0 // indirect
	github.com/valyala/tcplisten v1.0.0 // indirect
	golang.org/x/crypto v0.31.0 // indirect
	golang.org/x/net v0.33.0 // indirect
	golang.org/x/sync v0.7.0 // indirect
	golang.org/x/sys v0.28.0 // indirect
	google.golang.org/protobuf v1.34.2 // indirect
)

replace github.com/mdm/shared => ../shared
