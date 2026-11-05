# syntax=docker/dockerfile:1.7
FROM golang:1.22-alpine AS build
RUN apk add --no-cache git ca-certificates
WORKDIR /src
ENV GOFLAGS=-mod=mod
ENV GOSUMDB=off
COPY shared/ ./shared/
COPY telemetry-service/ ./telemetry-service/
WORKDIR /src/telemetry-service
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /out/telemetry-service ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/telemetry-service /usr/local/bin/telemetry-service
USER nonroot:nonroot
EXPOSE 8005
ENTRYPOINT ["/usr/local/bin/telemetry-service"]
