# syntax=docker/dockerfile:1.7
FROM golang:1.22-alpine AS build
RUN apk add --no-cache git ca-certificates
WORKDIR /src
ENV GOFLAGS=-mod=mod
ENV GOSUMDB=off
COPY shared/ ./shared/
COPY file-service/ ./file-service/
WORKDIR /src/file-service
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /out/file-service ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/file-service /usr/local/bin/file-service
USER nonroot:nonroot
EXPOSE 8007
ENTRYPOINT ["/usr/local/bin/file-service"]
