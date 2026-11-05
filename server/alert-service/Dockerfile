# syntax=docker/dockerfile:1.7
FROM golang:1.22-alpine AS build
RUN apk add --no-cache git ca-certificates
WORKDIR /src
ENV GOFLAGS=-mod=mod
ENV GOSUMDB=off
COPY shared/ ./shared/
COPY alert-service/ ./alert-service/
WORKDIR /src/alert-service
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /out/alert-service ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/alert-service /usr/local/bin/alert-service
USER nonroot:nonroot
EXPOSE 8010
ENTRYPOINT ["/usr/local/bin/alert-service"]
