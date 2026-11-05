FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y wget ca-certificates && rm -rf /var/lib/apt/lists/*
RUN wget --tries=3 --timeout=60 \
    https://github.com/minio/minio/releases/latest/download/minio \
    -O /usr/local/bin/minio && chmod +x /usr/local/bin/minio
EXPOSE 9000 9101
ENTRYPOINT ["/usr/local/bin/minio"]
