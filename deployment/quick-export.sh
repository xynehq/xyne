#!/bin/bash

# =============================================================================
# Quick Xyne Export Script
# =============================================================================
# Simplified script to quickly export Xyne for transfer to another machine
# =============================================================================

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Parse command line arguments
NO_EXPORT=false
FORCE_BUILD=false

for arg in "$@"; do
    case $arg in
        --no-export)
            NO_EXPORT=true
            shift
            ;;
        --force-build)
            FORCE_BUILD=true
            shift
            ;;
        cleanup)
            echo -e "${YELLOW}🧹 Cleaning up old export directories...${NC}"
            rm -rf xyne-portable-*
            echo -e "${GREEN}✅ Cleanup completed!${NC}"
            exit 0
            ;;
        --help|-h)
            echo "Usage: $0 [OPTIONS]"
            echo "Options:"
            echo "  --no-export     Skip creating tar file (for same-machine deployment)"
            echo "  --force-build   Force rebuild even if remote image is newer"
            echo "  cleanup         Remove old export directories"
            echo "  --help, -h      Show this help message"
            exit 0
            ;;
        *)
            # Unknown option
            ;;
    esac
done

echo -e "${BLUE}🚀 Xyne Quick Export${NC}"
echo "=================================="

# Check if Vespa base image should be rebuilt
check_vespa_image_update() {
    echo -e "${YELLOW}🔍 Checking Vespa base image for updates...${NC}"
    
    # Get current local vespa base image digest
    LOCAL_DIGEST=$(docker images --digests vespaengine/vespa:latest --format "{{.Digest}}" 2>/dev/null || echo "")
    
    # Pull latest vespa image to check for updates
    echo "📥 Checking remote vespaengine/vespa:latest..."
    docker pull vespaengine/vespa:latest >/dev/null 2>&1 || {
        echo -e "${RED}⚠️  Warning: Failed to check remote vespa image. Using local version.${NC}"
        return 1
    }
    
    # Get new digest after pull
    NEW_DIGEST=$(docker images --digests vespaengine/vespa:latest --format "{{.Digest}}" 2>/dev/null || echo "")
    
    if [ "$LOCAL_DIGEST" != "$NEW_DIGEST" ] && [ -n "$NEW_DIGEST" ]; then
        echo -e "${GREEN}🆕 New Vespa base image available, will rebuild GPU image${NC}"
        return 0
    else
        echo -e "${GREEN}✅ Vespa base image is up to date${NC}"
        return 1
    fi
}

# Determine if we need to create export directory
if [ "$NO_EXPORT" = "false" ]; then
    EXPORT_DIR="xyne-portable-$(date +%Y%m%d_%H%M%S)"
    mkdir -p "$EXPORT_DIR"
    echo -e "${YELLOW}📦 Building and exporting Xyne application...${NC}"
else
    echo -e "${YELLOW}📦 Building Xyne application (no export)...${NC}"
fi

# Build the main Xyne image
docker-compose -f docker-compose.prod.yml build app

# Check if we should rebuild Vespa GPU image
SHOULD_BUILD_VESPA=false
if [ "$FORCE_BUILD" = "true" ]; then
    echo -e "${YELLOW}🔨 Force building Vespa GPU image...${NC}"
    SHOULD_BUILD_VESPA=true
elif check_vespa_image_update; then
    SHOULD_BUILD_VESPA=true
elif ! docker images | grep -q "xyne-vespa-gpu"; then
    echo -e "${YELLOW}🏗️  Vespa GPU image not found locally, building...${NC}"
    SHOULD_BUILD_VESPA=true
fi

if [ "$SHOULD_BUILD_VESPA" = "true" ]; then
    echo -e "${YELLOW}🏗️  Building GPU-enabled Vespa image...${NC}"
    docker-compose -f docker-compose.prod.yml build vespa
else
    echo -e "${GREEN}✅ Using existing Vespa GPU image${NC}"
fi

# Export images only if not using --no-export
if [ "$NO_EXPORT" = "false" ]; then
    echo -e "${YELLOW}💾 Exporting Docker images...${NC}"
    
    # Export the main Xyne application image (contains sample data)
    docker save -o "$EXPORT_DIR/xyne-app.tar" xyne
    gzip "$EXPORT_DIR/xyne-app.tar"

    # Export the GPU-enabled Vespa image
    docker save -o "$EXPORT_DIR/xyne-vespa-gpu.tar" xyne-vespa-gpu
    gzip "$EXPORT_DIR/xyne-vespa-gpu.tar"
else
    echo -e "${GREEN}⏭️  Skipping image export (--no-export flag)${NC}"
fi

echo -e "${YELLOW}📝 Supporting images will be pulled from remote registry...${NC}"
echo "Images to be pulled on deployment:"
echo "  • busybox (for permission management)"
echo "  • postgres:15-alpine"
echo "  • prom/prometheus:latest"
echo "  • grafana/grafana:latest"
echo "  • grafana/loki:3.4.1"
echo "  • grafana/promtail:3.4.1"
echo ""
echo "Images included in export:"
echo "  • xyne (main application)"
echo "  • xyne-vespa-gpu (GPU-enabled Vespa with ONNX runtime)"

# Copy configuration files only if not using --no-export
if [ "$NO_EXPORT" = "false" ]; then
    echo -e "${YELLOW}📋 Copying configuration files...${NC}"

    # Copy essential files
    cp docker-compose.prod.yml "$EXPORT_DIR/docker-compose.yml"
    cp Dockerfile-vespa-gpu "$EXPORT_DIR/"
    cp prometheus-selfhosted.yml "$EXPORT_DIR/"
    cp loki-config.yaml "$EXPORT_DIR/"
    cp promtail-config.yaml "$EXPORT_DIR/"
    [[ -f "sample-data.tar.gz" ]] && cp sample-data.tar.gz "$EXPORT_DIR/"
    [[ -d "grafana" ]] && cp -r grafana "$EXPORT_DIR/"
    [[ -f "../server/.env" ]] && cp "../server/.env" "$EXPORT_DIR/.env.example"

    # Update docker-compose.yml to use local .env file instead of ../server/.env
    sed -i 's|../server/\.env|.env|g' "$EXPORT_DIR/docker-compose.yml"
else
    echo -e "${GREEN}⏭️  Skipping file copy (same-machine deployment)${NC}"
fi

# Create import and deploy scripts only if not using --no-export
if [ "$NO_EXPORT" = "false" ]; then
    echo -e "${YELLOW}📝 Creating import script...${NC}"

    # Create simple import script
    cat > "$EXPORT_DIR/import.sh" << 'EOF'
#!/bin/bash
echo "🚀 Importing Xyne application image..."

# Load Xyne application image
if [ -f "xyne-app.tar.gz" ]; then
    echo "Loading: xyne-app.tar.gz"
    gunzip -c "xyne-app.tar.gz" | docker load
else
    echo "❌ xyne-app.tar.gz not found!"
    exit 1
fi

# Load GPU-enabled Vespa image
if [ -f "xyne-vespa-gpu.tar.gz" ]; then
    echo "Loading: xyne-vespa-gpu.tar.gz"
    gunzip -c "xyne-vespa-gpu.tar.gz" | docker load
else
    echo "❌ xyne-vespa-gpu.tar.gz not found!"
    exit 1
fi

echo "📥 Pulling supporting images from remote registry..."
docker pull busybox
docker pull postgres:15-alpine
docker pull prom/prometheus:latest
docker pull grafana/grafana:latest
docker pull grafana/loki:3.4.1
docker pull grafana/promtail:3.4.1

echo "✅ Import complete!"
echo ""
echo "To deploy Xyne:"
echo "  1. Configure environment (optional): nano .env.example"
echo "  2. Start services: ./deploy.sh"
echo "  3. Access at: http://localhost:3000"
EOF

chmod +x "$EXPORT_DIR/import.sh"

# Create deployment script
cat > "$EXPORT_DIR/deploy.sh" << 'EOF'
#!/bin/bash
echo "🚀 Deploying Xyne..."

# Use fixed UID 1000 (only UID that works reliably)
CURRENT_UID=1000
CURRENT_GID=1000

# Create necessary directories with proper permissions
echo "📁 Creating data directories..."
mkdir -p ../xyne-data/{postgres-data,vespa-data,app-uploads,app-logs,app-assets,grafana-storage,loki-data,promtail-data,prometheus-data,ollama-data}

# Create Vespa tmp directory
mkdir -p ../xyne-data/vespa-data/tmp

# Set proper permissions for services (no root required)
echo "📋 Setting up permissions..."
chmod -f 755 ../xyne-data 2>/dev/null || true
chmod -f 755 ../xyne-data/* 2>/dev/null || true
chmod -f 755 ../xyne-data/vespa-data/tmp 2>/dev/null || true

# Set ownership using busybox containers (no sudo required)
echo "📋 Setting directory permissions using Docker containers..."

# Use busybox containers to set permissions without requiring sudo
docker run --rm -v "$(pwd)/../xyne-data/postgres-data:/data" busybox chown -R $CURRENT_UID:$CURRENT_GID /data
docker run --rm -v "$(pwd)/../xyne-data/vespa-data:/data" busybox chown -R $CURRENT_UID:$CURRENT_GID /data
docker run --rm -v "$(pwd)/../xyne-data/app-uploads:/data" busybox chown -R $CURRENT_UID:$CURRENT_GID /data
docker run --rm -v "$(pwd)/../xyne-data/app-logs:/data" busybox chown -R $CURRENT_UID:$CURRENT_GID /data 
docker run --rm -v "$(pwd)/../xyne-data/app-assets:/data" busybox chown -R $CURRENT_UID:$CURRENT_GID /data
docker run --rm -v "$(pwd)/../xyne-data/grafana-storage:/data" busybox chown -R $CURRENT_UID:$CURRENT_GID /data 
docker run --rm -v "$(pwd)/../xyne-data/ollama-data:/data" busybox chown -R $CURRENT_UID:$CURRENT_GID /data 

# Initialize prometheus and loki directories with correct permissions (as per docker-compose init services)
docker run --rm -v "$(pwd)/../xyne-data/prometheus-data:/data" busybox sh -c 'mkdir -p /data && chown -R 65534:65534 /data' 
docker run --rm -v "$(pwd)/../xyne-data/loki-data:/data" busybox sh -c 'mkdir -p /data && chown -R 10001:10001 /data' 
docker run --rm -v "$(pwd)/../xyne-data/promtail-data:/data" busybox sh -c 'mkdir -p /data && chown -R 10001:10001 /data' 

echo "✅ Permissions set using Docker containers (UID:GID 1000:1000)"
echo "ℹ️  Prometheus and Loki permissions handled by init containers"

echo "📋 Setting up configuration..."
# Copy .env.example to .env if .env doesn't exist
if [ ! -f .env ] && [ -f .env.example ]; then
    echo "📋 Copying .env.example to .env..."
    cp .env.example .env
fi

# Set Docker user environment variables to fixed UID 1000
export DOCKER_UID=1000
export DOCKER_GID=1000

# Get Docker group ID for Promtail socket access
DOCKER_GROUP_ID=$(getent group docker | cut -d: -f3 2>/dev/null || echo "999")
export DOCKER_GROUP_ID

# Add DOCKER_UID and DOCKER_GID to .env only if not already present
if ! grep -q "DOCKER_UID" .env 2>/dev/null; then
    echo "DOCKER_UID=1000" >> .env
fi
if ! grep -q "DOCKER_GID" .env 2>/dev/null; then
    echo "DOCKER_GID=1000" >> .env
fi
if ! grep -q "DOCKER_GROUP_ID" .env 2>/dev/null; then
    echo "DOCKER_GROUP_ID=$DOCKER_GROUP_ID" >> .env
fi

# Update docker-compose to use external data directory
sed -i 's|./data/|../xyne-data/|g' docker-compose.yml

echo "🚀 Starting services..."
# Start services with GPU runtime
docker-compose -f docker-compose.yml up -d

echo "🧹 Setting up Vespa cleanup cron job..."
# Create cleanup script for Vespa disk management
cat > vespa-cleanup.sh << INNEREOF
#!/bin/bash
# Vespa disk cleanup script - run daily to prevent disk overflow

echo "$(date): Starting Vespa cleanup..."

# Remove old ZooKeeper logs (keep only current)
docker exec vespa find /opt/vespa/var/zookeeper -name "log.*" -mtime +1 -exec rm -f {} \; 2>/dev/null || true

# Remove old application logs
docker exec vespa find /opt/vespa/var/db/vespa -name "*.log" -size +50M -mtime +7 -exec rm -f {} \; 2>/dev/null || true

# Remove file distribution cache files older than 7 days
docker exec vespa find /opt/vespa/var/db/vespa/filedistribution -type f -mtime +7 -exec rm -f {} \; 2>/dev/null || true

# Remove temporary files
docker exec vespa find /opt/vespa/var/tmp -type f -mtime +1 -exec rm -f {} \; 2>/dev/null || true

echo "$(date): Vespa cleanup completed"
INNEREOF

chmod +x vespa-cleanup.sh

echo "✅ Deployment started!"
echo ""
echo "🖥️  GPU-enabled Vespa configuration deployed"
echo "⚠️  Note: Requires NVIDIA Docker runtime and compatible GPU"
echo ""
echo "Access Xyne at:"
echo "  • Application: http://localhost:3000"
echo "  • Grafana:     http://localhost:3002"
echo "  • Prometheus:  http://localhost:9090"
echo "  • Vespa:       http://localhost:8080"
echo ""
echo "Data is stored in: ../xyne-data/"
echo "Check status: docker-compose -f docker-compose.yml ps"
echo "Check GPU usage: nvidia-smi"
EOF

    chmod +x "$EXPORT_DIR/deploy.sh"

    # Create README
    cat > "$EXPORT_DIR/README.md" << EOF
# Xyne Portable Package

## Quick Start

1. **Import Docker images:**
   \`\`\`bash
   ./import.sh
   \`\`\`

2. **Configure environment (optional):**
   \`\`\`bash
   nano .env.example
   \`\`\`

3. **Deploy Xyne:**
   \`\`\`bash
   ./deploy.sh
   \`\`\`

4. **Access Xyne at:** http://localhost:3000

## What's Included

- ✅ Xyne application with pre-populated sample data
- ✅ PostgreSQL database
- ✅ Vespa search engine  
- ✅ Prometheus monitoring
- ✅ Grafana dashboards
- ✅ Loki log aggregation
- ✅ All configuration files

## Package Size

$(du -sh . 2>/dev/null | cut -f1) total

## Support

For issues, check logs with:
\`\`\`bash
docker-compose logs
\`\`\`
EOF

    # Calculate and display results
    TOTAL_SIZE=$(du -sh "$EXPORT_DIR" | cut -f1)

    echo ""
    echo -e "${YELLOW}📦 Creating archive for easy transfer...${NC}"

    # Create tar.gz archive
    ARCHIVE_NAME="xyne-portable-$(date +%Y%m%d_%H%M%S).tar.gz"
    tar -czf "$ARCHIVE_NAME" "$EXPORT_DIR"
    ARCHIVE_SIZE=$(du -sh "$ARCHIVE_NAME" | cut -f1)

    echo ""
    echo -e "${GREEN}✅ Export completed successfully!${NC}"
    echo "=================================="
    echo "📁 Export directory: $EXPORT_DIR"
    echo "📦 Archive file: $ARCHIVE_NAME"
    echo "💾 Directory size: $TOTAL_SIZE"
    echo "💾 Archive size: $ARCHIVE_SIZE"
    echo ""
    echo -e "${BLUE}📦 To transfer to another machine:${NC}"
    echo "Option 1: Transfer archive file"
    echo "  1. Copy '$ARCHIVE_NAME' to target machine"
    echo "  2. Extract: tar -xzf '$ARCHIVE_NAME'"
    echo "  3. cd into extracted directory"
    echo "  4. Run: ./import.sh then ./deploy.sh"
    echo ""
    echo "Option 2: Transfer directory"
    echo "  1. Copy entire '$EXPORT_DIR' directory"
    echo "  2. On target machine, run: ./import.sh then ./deploy.sh"
else
    echo ""
    echo -e "${GREEN}✅ Build completed successfully!${NC}"
    echo "=================================="
    echo -e "${BLUE}🚀 For same-machine deployment:${NC}"
    echo "  1. Ensure environment variables are set:"
    echo "     export DOCKER_UID=1000"
    echo "     export DOCKER_GID=1000"
    echo "     export DOCKER_GROUP_ID=\$(getent group docker | cut -d: -f3 2>/dev/null || echo \"999\")"
    echo "  2. Start services: docker-compose -f docker-compose.prod.yml up -d"
    echo "  3. Access at: http://localhost:3000"
fi
