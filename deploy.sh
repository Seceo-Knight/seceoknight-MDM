#!/bin/bash
set -e

echo ""
echo "================================================="
echo "   SeceoKnight MDM — Automated Deployment"
echo "================================================="
echo ""

cd "$(dirname "$0")/server"

SERVER_IP=$(hostname -I | awk '{print $1}')
echo "[1/4] Detected server IP: $SERVER_IP"

if [ ! -f .env ]; then
    echo "[2/4] No .env found — creating one automatically..."
    sed "s|YOUR_SERVER_IP|$SERVER_IP|g" .env.example > .env
    echo "      .env created with IP $SERVER_IP ✓"
else
    echo "[2/4] .env already exists ✓"
    sed -i "s|MINIO_PUBLIC_ENDPOINT=.*|MINIO_PUBLIC_ENDPOINT=$SERVER_IP:9000|g" .env
    sed -i "s|PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=http://$SERVER_IP:8080|g" .env
fi

export $(grep -v '^#' .env | xargs 2>/dev/null)

echo "[3/4] Generating SeaweedFS S3 config..."
mkdir -p infra/seaweedfs
cat > infra/seaweedfs/s3.json << ENDJSON
{
  "identities": [
    {
      "name": "admin",
      "credentials": [
        {
          "accessKey": "${MINIO_ACCESS_KEY:-minioadmin}",
          "secretKey": "${MINIO_SECRET_KEY:-minioadmin}"
        }
      ],
      "actions": ["Read", "Write", "List", "Tagging", "Admin"]
    }
  ]
}
ENDJSON

echo "[4/4] Starting all containers..."
docker compose up -d

echo ""
echo "================================================="
echo "  ✓ SeceoKnight MDM is running!"
echo ""
echo "  Dashboard : http://$SERVER_IP"
echo "  Grafana   : http://$SERVER_IP:3001"
echo ""
echo "  Default login:"
echo "    Email   : admin@mdm.local"
echo "    Password: ChangeMe!123"
echo "================================================="
echo ""
