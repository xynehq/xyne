#!/bin/bash

# =============================================================================
# Quick Xyne Export Script (Portable Version)
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

echo -e "${BLUE}🚀 Xyne Portable Export${NC}"
echo "=================================="

# Set up environment variables for Docker user/group
export DOCKER_UID=$(id -u)
export DOCKER_GID=$(id -g)

# Determine if we need to create export directory
if [ "$NO_EXPORT" = "false" ]; then
    EXPORT_DIR="xyne-portable-$(date +%Y%m%d_%H%M%S)"
    mkdir -p "$EXPORT_DIR"
    echo -e "${YELLOW}📦 Building and exporting Xyne application...${NC}"
else
    echo -e "${YELLOW}📦 Building Xyne application (no export)...${NC}"
fi

# Build the main Xyne image
docker-compose -f docker-compose.yml -f docker-compose.app.yml -f docker-compose.infrastructure.yml build app

# Build Vespa GPU image if needed
if [ "$FORCE_BUILD" = "true" ] || ! docker images | grep -q "xyne-vespa-gpu"; then
    echo -e "${YELLOW}🏗️  Building GPU-enabled Vespa image...${NC}"
    docker-compose -f docker-compose.yml -f docker-compose.infrastructure.yml build vespa
else
    echo -e "${GREEN}✅ Using existing Vespa GPU image${NC}"
fi

# Export images only if not using --no-export
if [ "$NO_EXPORT" = "false" ]; then
    echo -e "${YELLOW}💾 Exporting Docker images...${NC}"
    
    # Export the main Xyne application image
    docker save -o "$EXPORT_DIR/xyne-app.tar" xyne
    gzip "$EXPORT_DIR/xyne-app.tar"

    # Export the GPU-enabled Vespa image
    docker save -o "$EXPORT_DIR/xyne-vespa-gpu.tar" xyne-vespa-gpu
    gzip "$EXPORT_DIR/xyne-vespa-gpu.tar"

    echo -e "${YELLOW}📋 Copying configuration files...${NC}"

    # Copy all portable configuration files
    cp docker-compose.yml "$EXPORT_DIR/"
    cp docker-compose.app.yml "$EXPORT_DIR/"
    cp docker-compose.infrastructure.yml "$EXPORT_DIR/"
    cp docker-compose.infrastructure-cpu.yml "$EXPORT_DIR/"
    cp Dockerfile-vespa-gpu "$EXPORT_DIR/" 2>/dev/null || echo "Dockerfile-vespa-gpu not found"
    cp prometheus-selfhosted.yml "$EXPORT_DIR/"
    cp loki-config.yaml "$EXPORT_DIR/"
    cp promtail-config.yaml "$EXPORT_DIR/"
    cp deploy.sh "$EXPORT_DIR/"
    [[ -d "grafana" ]] && cp -r grafana "$EXPORT_DIR/"
    [[ -f "../../server/.env" ]] && cp "../../server/.env" "$EXPORT_DIR/.env.example"

    # Create import script
    cat > "$EXPORT_DIR/import.sh" << 'EOF'
#!/bin/bash
echo "🚀 Importing Xyne application..."

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
echo "  2. Start services: ./deploy.sh start"
echo "  3. Access at: http://localhost:3000"
echo ""
echo "For app updates:"
echo "  ./deploy.sh update-app  # Quick app-only update"
EOF

    chmod +x "$EXPORT_DIR/import.sh"
    chmod +x "$EXPORT_DIR/deploy.sh"

    echo -e "${GREEN}✅ Export completed: $EXPORT_DIR${NC}"
    echo ""
    echo -e "${BLUE}📦 Package contents:${NC}"
    echo "  • Docker images: xyne-app.tar.gz, xyne-vespa-gpu.tar.gz"
    echo "  • Split compose files for efficient updates"
    echo "  • Monitoring configurations"
    echo "  • Deployment scripts"
    echo ""
    echo -e "${BLUE}📋 Next steps:${NC}"
    echo "  1. Transfer $EXPORT_DIR to target machine"
    echo "  2. Run: ./import.sh"
    echo "  3. Run: ./deploy.sh start"
    echo "  4. For app updates: ./deploy.sh update-app"
else
    echo -e "${GREEN}⏭️  Build completed (no export)${NC}"
fi

echo -e "${YELLOW}💡 Efficient Update Usage:${NC}"
echo "  ./deploy.sh update-app     # Update only app (fast)"
echo "  ./deploy.sh update-infra   # Update infrastructure"
echo "  ./deploy.sh logs app       # View app logs"
echo "  ./deploy.sh status         # Check service status"