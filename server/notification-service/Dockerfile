# syntax=docker/dockerfile:1.7
FROM golang:1.22-alpine AS build
RUN apk add --no-cache git ca-certificates
WORKDIR /src
ENV GOFLAGS=-mod=mod
ENV GOSUMDB=off
COPY shared/ ./shared/
COPY notification-service/ ./notification-service/
WORKDIR /src/notification-service
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /out/notification-service ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/notification-service /usr/local/bin/notification-service
USER nonroot:nonroot
EXPOSE 8006
ENTRYPOINT ["/usr/local/bin/notification-service"]
