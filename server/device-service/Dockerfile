# syntax=docker/dockerfile:1.7
FROM golang:1.22-alpine AS build
RUN apk add --no-cache git ca-certificates
WORKDIR /src
ENV GOFLAGS=-mod=mod
ENV GOSUMDB=off
COPY shared/ ./shared/
COPY device-service/ ./device-service/
WORKDIR /src/device-service
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /out/device-service ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/device-service /usr/local/bin/device-service
USER nonroot:nonroot
EXPOSE 8002
ENTRYPOINT ["/usr/local/bin/device-service"]
