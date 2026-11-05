# syntax=docker/dockerfile:1.7
FROM golang:1.22-alpine AS build
RUN apk add --no-cache git ca-certificates
WORKDIR /src
ENV GOFLAGS=-mod=mod
ENV GOSUMDB=off
COPY shared/ ./shared/
COPY command-service/ ./command-service/
WORKDIR /src/command-service
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /out/command-service ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/command-service /usr/local/bin/command-service
USER nonroot:nonroot
EXPOSE 8004
ENTRYPOINT ["/usr/local/bin/command-service"]
