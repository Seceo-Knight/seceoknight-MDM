# syntax=docker/dockerfile:1.7
# Multi-stage build for the auth-service. Builds from the monorepo root so the
# `replace github.com/mdm/shared => ../shared` in go.mod resolves correctly.
FROM golang:1.22-alpine AS build
RUN apk add --no-cache git ca-certificates
WORKDIR /src
ENV GOFLAGS=-mod=mod
ENV GOSUMDB=off

COPY shared/ ./shared/
COPY auth-service/ ./auth-service/

WORKDIR /src/auth-service
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /out/auth-service ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/auth-service /usr/local/bin/auth-service
USER nonroot:nonroot
EXPOSE 8001
ENTRYPOINT ["/usr/local/bin/auth-service"]
