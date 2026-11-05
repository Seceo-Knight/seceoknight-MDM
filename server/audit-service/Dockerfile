# syntax=docker/dockerfile:1.7
FROM golang:1.22-alpine AS build
RUN apk add --no-cache git ca-certificates
WORKDIR /src
ENV GOFLAGS=-mod=mod
ENV GOSUMDB=off
COPY shared/ ./shared/
COPY audit-service/ ./audit-service/
WORKDIR /src/audit-service
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /out/audit-service ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/audit-service /usr/local/bin/audit-service
USER nonroot:nonroot
EXPOSE 8008
ENTRYPOINT ["/usr/local/bin/audit-service"]
