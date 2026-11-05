# syntax=docker/dockerfile:1.7
FROM golang:1.22-alpine AS build
RUN apk add --no-cache git ca-certificates
WORKDIR /src
ENV GOFLAGS=-mod=mod
ENV GOSUMDB=off
COPY shared/ ./shared/
COPY policy-service/ ./policy-service/
WORKDIR /src/policy-service
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /out/policy-service ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/policy-service /usr/local/bin/policy-service
USER nonroot:nonroot
EXPOSE 8003
ENTRYPOINT ["/usr/local/bin/policy-service"]
