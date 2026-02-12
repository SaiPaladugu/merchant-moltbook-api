#!/bin/bash
#
# Deploy a new frontend build to GCP Cloud Run.
#
# Usage:
#   ./scripts/deploy-frontend.sh path/to/build.zip
#   ./scripts/deploy-frontend.sh path/to/build-folder/
#
# What it does:
#   1. Extracts/copies the frontend build into frontend/
#   2. Patches API URLs for IAP compatibility (if needed)
#   3. Builds Docker image via Cloud Build
#   4. Deploys to Cloud Run
#
set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <build.zip or build-folder>"
  exit 1
fi

PROJ="shopify-hd-merchant-moltbook"
REGION="us-central1"
REPO="us-central1-docker.pkg.dev/$PROJ/moltbook-repo"
CONN_NAME="$PROJ:$REGION:moltbook-db"
ENV_FILE="/tmp/moltbook-env.yaml"

echo "=== Step 1: Extract frontend build ==="
rm -rf frontend

if [ -f "$1" ] && [[ "$1" == *.zip ]]; then
  echo "Unzipping $1..."
  unzip -qo "$1" -d /tmp/frontend-extract
  # Handle nested directory (zip might have a single folder inside)
  INNER=$(find /tmp/frontend-extract -maxdepth 1 -mindepth 1 -type d | head -1)
  if [ -n "$INNER" ] && [ -f "$INNER/server.js" ]; then
    cp -r "$INNER" frontend
  else
    cp -r /tmp/frontend-extract frontend
  fi
  rm -rf /tmp/frontend-extract
elif [ -d "$1" ]; then
  echo "Copying $1..."
  cp -r "$1" frontend
else
  echo "Error: $1 is not a zip file or directory"
  exit 1
fi

# Verify the build
if [ ! -f "frontend/server.js" ] || [ ! -d "frontend/.next" ]; then
  echo "Error: Invalid build — missing server.js or .next directory"
  ls -la frontend/
  exit 1
fi
echo "Frontend build OK (server.js + .next found)"

echo ""
echo "=== Step 2: Patch API URLs for IAP ==="

EXTERNAL_URL="https://moltbook-api-538486406156.us-central1.run.app/api/v1"
LOCAL_URL="http://localhost:3000/api/v1"

# Patch server-side: external URL → localhost (SSR stays inside container)
SSR_EXT=$(grep -rl "$EXTERNAL_URL" frontend/.next/server/ 2>/dev/null | wc -l | tr -d ' ')
if [ "$SSR_EXT" -gt "0" ]; then
  echo "Patching $SSR_EXT server-side files: external URL → localhost:3000"
  grep -rl "$EXTERNAL_URL" frontend/.next/server/ | xargs sed -i '' "s|$EXTERNAL_URL|$LOCAL_URL|g"
fi

# Patch client-side: external URL → relative
CLIENT_EXT=$(grep -rl "$EXTERNAL_URL" frontend/.next/static/ 2>/dev/null | wc -l | tr -d ' ')
if [ "$CLIENT_EXT" -gt "0" ]; then
  echo "Patching $CLIENT_EXT client-side files: external URL → /api/v1"
  grep -rl "$EXTERNAL_URL" frontend/.next/static/ | xargs sed -i '' "s|$EXTERNAL_URL|/api/v1|g"
fi

# Patch client-side: localhost:3000 → relative (Adit may have set localhost as base)
CLIENT_LOCAL=$(grep -rl "localhost:3000/api/v1" frontend/.next/static/ 2>/dev/null | wc -l | tr -d ' ')
if [ "$CLIENT_LOCAL" -gt "0" ]; then
  echo "Patching $CLIENT_LOCAL client-side files: localhost:3000 → /api/v1"
  grep -rl "localhost:3000/api/v1" frontend/.next/static/ | xargs sed -i '' "s|http://localhost:3000/api/v1|/api/v1|g"
fi

# Final check
REMAINING=$(grep -rl "localhost:3000/api" frontend/.next/static/ 2>/dev/null | wc -l | tr -d ' ')
if [ "$REMAINING" -gt "0" ]; then
  echo "WARNING: $REMAINING client files still have localhost:3000"
else
  echo "Client-side URLs clean (all relative)"
fi

echo ""
echo "=== Step 3: Build Docker image ==="
gcloud builds submit \
  --project=$PROJ \
  --tag=$REPO/moltbook-api:latest \
  --quiet 2>&1 | tail -5

echo ""
echo "=== Step 4: Deploy to Cloud Run ==="
gcloud run deploy moltbook-api \
  --project=$PROJ \
  --region=$REGION \
  --image=$REPO/moltbook-api:latest \
  --platform=managed \
  --port=3000 \
  --min-instances=1 \
  --max-instances=3 \
  --memory=1Gi \
  --timeout=300 \
  --set-cloudsql-instances=$CONN_NAME \
  --env-vars-file=$ENV_FILE \
  --quiet 2>&1 | tail -5

echo ""
echo "=== Done! ==="
echo "Frontend deployed to: https://moltbook-api-538486406156.us-central1.run.app"
echo ""
