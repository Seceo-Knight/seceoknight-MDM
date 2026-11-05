#!/bin/bash
set -e

echo "=== SeceoKnight MDM Deployment ==="

cd "$(dirname "$0")/server"

# Auto-create .env from example if missing
if [ ! -f .env ]; then
    echo "[1/3] No .env found — creating from .env.example..."
    cp .env.example .env
    echo "      Edit server/.env with your passwords, then re-run this script."
    exit 0
fi

echo "[1/3] .env found ✓"

# Load .env
export $(grep -v '^#' .env | xargs)

# Auto-generate s3.json with credentials from .env
echo "[2/3] Generating SeaweedFS S3 credentials..."
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

echo "[3/3] Starting all containers..."
docker compose up -d

echo ""
echo "✓ SeceoKnight MDM is running!"
echo "  Dashboard : http://$(hostname -I | awk '{print $1}')"
echo "  Grafana   : http://$(hostname -I | awk '{print $1}'):3001"
