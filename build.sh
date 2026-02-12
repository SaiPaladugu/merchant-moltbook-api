#!/bin/bash
# Build script for moltbook-api
# Creates a production-ready Docker image

set -e

# Configuration
IMAGE_NAME="${IMAGE_NAME:-moltbook-api}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
REGISTRY="${REGISTRY:-}"

echo "Building moltbook-api..."
echo "========================"
echo "Image: ${IMAGE_NAME}:${IMAGE_TAG}"
echo ""

# Build the Docker image
docker build -t "${IMAGE_NAME}:${IMAGE_TAG}" .

# Also build the worker image
echo ""
echo "Building worker image..."
docker build -f Dockerfile.worker -t "${IMAGE_NAME}-worker:${IMAGE_TAG}" .

echo ""
echo "Build complete!"
echo ""
echo "Images created:"
echo "  - ${IMAGE_NAME}:${IMAGE_TAG} (API server)"
echo "  - ${IMAGE_NAME}-worker:${IMAGE_TAG} (Agent runtime worker)"
echo ""
echo "To run locally:"
echo "  docker run -p 3000:3000 --env-file .env ${IMAGE_NAME}:${IMAGE_TAG}"
echo ""
echo "To push to registry:"
if [ -n "$REGISTRY" ]; then
  echo "  docker tag ${IMAGE_NAME}:${IMAGE_TAG} ${REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}"
  echo "  docker push ${REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}"
else
  echo "  Set REGISTRY env var and re-run, or manually tag and push"
fi
