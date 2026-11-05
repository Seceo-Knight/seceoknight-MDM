# syntax=docker/dockerfile:1.7
FROM golang:1.22-alpine AS build
RUN apk add --no-cache git ca-certificates
WORKDIR /src
ENV GOFLAGS=-mod=mod
ENV GOSUMDB=off
COPY shared/ ./shared/
COPY compliance-service/ ./compliance-service/
WORKDIR /src/compliance-service
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /out/compliance-service ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/compliance-service /usr/local/bin/compliance-service
USER nonroot:nonroot
EXPOSE 8009
ENTRYPOINT ["/usr/local/bin/compliance-service"]
