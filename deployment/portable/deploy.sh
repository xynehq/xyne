#!/bin/bash

# =============================================================================
# Xyne Deployment Script
# =============================================================================
# Manages infrastructure and application services separately for efficient updates
# =============================================================================

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

show_help() {
    echo "Usage: $0 [COMMAND] [OPTIONS]"
    echo ""
    echo "Commands:"
    echo "  start              Start all services"
    echo "  stop               Stop all services"
    echo "  restart            Restart all services"
    echo "  update-app         Update only the app service (efficient for code changes)"
    echo "  update-infra       Update infrastructure services"
    echo "  logs [service]     Show logs for all services or specific service"
    echo "  status             Show status of all services"
    echo "  cleanup            Clean up old containers and images"
    echo "  db-generate        Generate new database migrations (run after schema changes)"
    echo "  db-migrate         Apply pending database migrations"
    echo "  db-studio          Open Drizzle Studio for database management"
    echo "  help               Show this help message"
    echo ""
    echo "Options:"
    echo "  --force-gpu        Force GPU mode even if GPU not detected"
    echo "  --force-cpu        Force CPU-only mode even if GPU detected"
    echo ""
    echo "Examples:"
    echo "  $0 start           # Start all services (auto-detect GPU/CPU)"
    echo "  $0 start --force-cpu    # Force CPU-only mode"
    echo "  $0 update-app      # Quick app update without touching DB/Vespa"
    echo "  $0 logs app        # Show app logs"
    echo "  $0 db-generate     # Generate migrations after schema changes"
    echo "  $0 db-migrate      # Apply pending migrations"
}

detect_gpu_support() {
    # Check if GPU support should be forced
    if [ "$FORCE_GPU" = "true" ]; then
        echo -e "${YELLOW}🔧 GPU mode forced via --force-gpu flag${NC}"
        return 0
    fi
    
    if [ "$FORCE_CPU" = "true" ]; then
        echo -e "${YELLOW}🔧 CPU-only mode forced via --force-cpu flag${NC}"
        return 1
    fi
    
    # Auto-detect GPU support
    echo -e "${YELLOW}🔍 Detecting GPU support...${NC}"
    
    # Check for NVIDIA GPU and Docker GPU runtime
    if command -v nvidia-smi >/dev/null 2>&1; then
        if nvidia-smi >/dev/null 2>&1; then
            echo -e "${GREEN}✅ NVIDIA GPU detected${NC}"
            
            # Check for Docker GPU runtime
            if docker info 2>/dev/null | grep -i nvidia >/dev/null 2>&1; then
                echo -e "${GREEN}✅ Docker GPU runtime detected${NC}"
                return 0
            else
                echo -e "${YELLOW}⚠️  NVIDIA GPU found but Docker GPU runtime not available${NC}"
                echo -e "${BLUE}ℹ️  Install NVIDIA Container Toolkit for GPU acceleration${NC}"
                return 1
            fi
        fi
    fi
    
    # Check for Apple Silicon or other non-NVIDIA systems
    if [ "$(uname -m)" = "arm64" ] && [ "$(uname -s)" = "Darwin" ]; then
        echo -e "${BLUE}ℹ️  Apple Silicon detected - using CPU-only mode${NC}"
        return 1
    fi
    
    echo -e "${BLUE}ℹ️  No compatible GPU detected - using CPU-only mode${NC}"
    return 1
}

# Parse command line arguments
COMMAND=${1:-""}
FORCE_GPU=false
FORCE_CPU=false

# Show help if no command provided
if [ -z "$COMMAND" ]; then
    show_help
    exit 0
fi

# Parse additional arguments
shift
while [[ $# -gt 0 ]]; do
    case $1 in
        --force-gpu)
            FORCE_GPU=true
            shift
            ;;
        --force-cpu)
            FORCE_CPU=true
            shift
            ;;
        *)
            # Unknown option, might be a service name for logs command
            break
            ;;
    esac
done

setup_environment() {
    echo -e "${YELLOW}📋 Setting up environment...${NC}"
    
    # Create necessary directories with proper permissions
    echo "📁 Creating data directories..."
    mkdir -p ./data/{postgres-data,vespa-data,app-uploads,app-logs,app-assets,app-migrations,grafana-storage,loki-data,promtail-data,prometheus-data,ollama-data}
    
    # Create Vespa tmp directory
    mkdir -p ./data/vespa-data/tmp
    
    # Set proper permissions for services
    echo "📋 Setting up permissions..."
    chmod -f 755 ./data 2>/dev/null || true
    chmod -f 755 ./data/* 2>/dev/null || true
    chmod -f 755 ./data/vespa-data/tmp 2>/dev/null || true
    
    # Copy .env.example to .env if .env doesn't exist
    if [ ! -f .env ] && [ -f .env.example ]; then
        echo "📋 Copying .env.example to .env..."
        cp .env.example .env
    fi
    
    # Set Docker user environment variables
    export DOCKER_UID=1000
    export DOCKER_GID=1000
    
    # Get Docker group ID for Promtail socket access (fallback to 999 if getent not available)
    if command -v getent >/dev/null 2>&1; then
        DOCKER_GROUP_ID=$(getent group docker | cut -d: -f3 2>/dev/null || echo "999")
    else
        # macOS fallback - check if docker group exists in /etc/group
        DOCKER_GROUP_ID=$(grep "^docker:" /etc/group 2>/dev/null | cut -d: -f3 || echo "999")
    fi
    export DOCKER_GROUP_ID
    
    # Update .env file with required variables
    if ! grep -q "DOCKER_UID" .env 2>/dev/null; then
        echo "DOCKER_UID=1000" >> .env
    fi
    if ! grep -q "DOCKER_GID" .env 2>/dev/null; then
        echo "DOCKER_GID=1000" >> .env
    fi
    if ! grep -q "DOCKER_GROUP_ID" .env 2>/dev/null; then
        echo "DOCKER_GROUP_ID=$DOCKER_GROUP_ID" >> .env
    fi
    
    # Create network if it doesn't exist
    docker network create xyne 2>/dev/null || echo "Network 'xyne' already exists"
}

setup_permissions() {
    echo -e "${YELLOW}📋 Setting directory permissions using Docker containers...${NC}"
    
    # Use busybox containers to set permissions without requiring sudo
    docker run --rm -v "$(pwd)/data/postgres-data:/data" busybox chown -R 1000:1000 /data 2>/dev/null || true
    docker run --rm -v "$(pwd)/data/vespa-data:/data" busybox chown -R 1000:1000 /data 2>/dev/null || true
    docker run --rm -v "$(pwd)/data/app-uploads:/data" busybox chown -R 1000:1000 /data 2>/dev/null || true
    docker run --rm -v "$(pwd)/data/app-logs:/data" busybox chown -R 1000:1000 /data 2>/dev/null || true
    docker run --rm -v "$(pwd)/data/app-assets:/data" busybox chown -R 1000:1000 /data 2>/dev/null || true
    docker run --rm -v "$(pwd)/data/app-migrations:/data" busybox chown -R 1000:1000 /data 2>/dev/null || true
    docker run --rm -v "$(pwd)/data/grafana-storage:/data" busybox chown -R 1000:1000 /data 2>/dev/null || true
    docker run --rm -v "$(pwd)/data/ollama-data:/data" busybox chown -R 1000:1000 /data 2>/dev/null || true
    
    # Initialize prometheus and loki directories with correct permissions
    docker run --rm -v "$(pwd)/data/prometheus-data:/data" busybox sh -c 'mkdir -p /data && chown -R 65534:65534 /data' 2>/dev/null || true
    docker run --rm -v "$(pwd)/data/loki-data:/data" busybox sh -c 'mkdir -p /data && chown -R 10001:10001 /data' 2>/dev/null || true
    docker run --rm -v "$(pwd)/data/promtail-data:/data" busybox sh -c 'mkdir -p /data && chown -R 10001:10001 /data' 2>/dev/null || true
    
    echo -e "${GREEN}✅ Permissions configured${NC}"
}

start_infrastructure() {
    echo -e "${YELLOW}🏗️  Starting infrastructure services...${NC}"
    
    # Determine which infrastructure compose file to use
    INFRA_COMPOSE=$(get_infrastructure_compose)
    if detect_gpu_support >/dev/null 2>&1; then
        echo -e "${GREEN}🚀 Using GPU-accelerated Vespa${NC}"
    else
        echo -e "${BLUE}💻 Using CPU-only Vespa${NC}"
    fi
    
    docker-compose -f docker-compose.yml -f "$INFRA_COMPOSE" up -d
    echo -e "${GREEN}✅ Infrastructure services started${NC}"
}

start_app() {
    echo -e "${YELLOW}🚀 Starting application service...${NC}"
    INFRA_COMPOSE=$(get_infrastructure_compose)
    docker-compose -f docker-compose.yml -f "$INFRA_COMPOSE" -f docker-compose.app.yml up -d app
    echo -e "${GREEN}✅ Application service started${NC}"
}

get_infrastructure_compose() {
    if detect_gpu_support >/dev/null 2>&1; then
        echo "docker-compose.infrastructure.yml"
    else
        echo "docker-compose.infrastructure-cpu.yml"
    fi
}

stop_all() {
    echo -e "${YELLOW}🛑 Stopping all services...${NC}"
    INFRA_COMPOSE=$(get_infrastructure_compose)
    docker-compose -f docker-compose.yml -f docker-compose.app.yml -f "$INFRA_COMPOSE" down
    echo -e "${GREEN}✅ All services stopped${NC}"
}

update_app() {
    echo -e "${YELLOW}🔄 Updating application service only...${NC}"
    
    # Build new image
    echo "🏗️  Building new app image..."
    INFRA_COMPOSE=$(get_infrastructure_compose)
    docker-compose -f docker-compose.yml -f "$INFRA_COMPOSE" -f docker-compose.app.yml build app
    
    # Stop and recreate only the app service
    echo "🔄 Recreating app service..."
    docker-compose -f docker-compose.yml -f "$INFRA_COMPOSE" -f docker-compose.app.yml up -d --force-recreate app
    
    echo -e "${GREEN}✅ Application updated successfully${NC}"
    echo -e "${BLUE}ℹ️  Database and Vespa services were not affected${NC}"
}

update_infrastructure() {
    echo -e "${YELLOW}🔄 Updating infrastructure services...${NC}"
    INFRA_COMPOSE=$(get_infrastructure_compose)
    docker-compose -f docker-compose.yml -f "$INFRA_COMPOSE" pull
    docker-compose -f docker-compose.yml -f "$INFRA_COMPOSE" up -d --force-recreate
    echo -e "${GREEN}✅ Infrastructure services updated${NC}"
}

show_logs() {
    local service=$1
    INFRA_COMPOSE=$(get_infrastructure_compose)
    if [ -n "$service" ]; then
        echo -e "${YELLOW}📋 Showing logs for $service...${NC}"
        docker-compose -f docker-compose.yml -f docker-compose.app.yml -f "$INFRA_COMPOSE" logs -f "$service"
    else
        echo -e "${YELLOW}📋 Showing logs for all services...${NC}"
        docker-compose -f docker-compose.yml -f docker-compose.app.yml -f "$INFRA_COMPOSE" logs -f
    fi
}

show_status() {
    echo -e "${YELLOW}📊 Service Status:${NC}"
    INFRA_COMPOSE=$(get_infrastructure_compose)
    docker-compose -f docker-compose.yml -f docker-compose.app.yml -f "$INFRA_COMPOSE" ps
    echo ""
    echo -e "${YELLOW}🌐 Access URLs:${NC}"
    echo "  • Xyne Application: http://localhost:3000"
    echo "  • Grafana: http://localhost:3002"
    echo "  • Prometheus: http://localhost:9090"
    echo "  • Loki: http://localhost:3100"
    
    # Show GPU/CPU mode
    if detect_gpu_support >/dev/null 2>&1; then
        echo -e "${GREEN}  • Vespa Mode: GPU-accelerated${NC}"
    else
        echo -e "${BLUE}  • Vespa Mode: CPU-only${NC}"
    fi
}

cleanup() {
    echo -e "${YELLOW}🧹 Cleaning up old containers and images...${NC}"
    docker system prune -f
    docker volume prune -f
    echo -e "${GREEN}✅ Cleanup completed${NC}"
}

db_generate() {
    echo -e "${YELLOW}🗄️  Generating database migrations...${NC}"
    
    # Check if app is running
    INFRA_COMPOSE=$(get_infrastructure_compose)
    if ! docker-compose -f docker-compose.yml -f "$INFRA_COMPOSE" -f docker-compose.app.yml ps | grep -q "xyne-app.*Up"; then
        echo -e "${RED}❌ App service is not running. Start with: ./deploy.sh start${NC}"
        exit 1
    fi
    
    # Run drizzle generate inside the container
    docker-compose -f docker-compose.yml -f "$INFRA_COMPOSE" -f docker-compose.app.yml exec app bun run generate
    
    echo -e "${GREEN}✅ Migrations generated and saved to ./data/app-migrations/${NC}"
    echo -e "${BLUE}ℹ️  Generated migrations will persist across container updates${NC}"
}

db_migrate() {
    echo -e "${YELLOW}🗄️  Applying database migrations...${NC}"
    
    # Check if app is running
    INFRA_COMPOSE=$(get_infrastructure_compose)
    if ! docker-compose -f docker-compose.yml -f "$INFRA_COMPOSE" -f docker-compose.app.yml ps | grep -q "xyne-app.*Up"; then
        echo -e "${RED}❌ App service is not running. Start with: ./deploy.sh start${NC}"
        exit 1
    fi
    
    # Run drizzle migrate inside the container
    docker-compose -f docker-compose.yml -f "$INFRA_COMPOSE" -f docker-compose.app.yml exec app bun run migrate
    
    echo -e "${GREEN}✅ Database migrations applied successfully${NC}"
}

db_studio() {
    echo -e "${YELLOW}🗄️  Opening Drizzle Studio...${NC}"
    echo -e "${BLUE}ℹ️  Drizzle Studio will be available at: http://localhost:4983${NC}"
    echo -e "${BLUE}ℹ️  Press Ctrl+C to stop Drizzle Studio${NC}"
    
    # Check if app is running
    INFRA_COMPOSE=$(get_infrastructure_compose)
    if ! docker-compose -f docker-compose.yml -f "$INFRA_COMPOSE" -f docker-compose.app.yml ps | grep -q "xyne-app.*Up"; then
        echo -e "${RED}❌ App service is not running. Start with: ./deploy.sh start${NC}"
        exit 1
    fi
    
    # Run drizzle studio inside the container with port forwarding
    docker-compose -f docker-compose.yml -f "$INFRA_COMPOSE" -f docker-compose.app.yml exec -p 4983:4983 app bun drizzle-kit studio
}

# Main script logic
case $COMMAND in
    start)
        setup_environment
        setup_permissions
        start_infrastructure
        sleep 10  # Wait for infrastructure to be ready
        start_app
        show_status
        ;;
    stop)
        stop_all
        ;;
    restart)
        stop_all
        sleep 5
        setup_environment
        setup_permissions
        start_infrastructure
        sleep 10
        start_app
        show_status
        ;;
    update-app)
        setup_environment
        update_app
        show_status
        ;;
    update-infra)
        setup_environment
        update_infrastructure
        show_status
        ;;
    logs)
        show_logs $2
        ;;
    status)
        show_status
        ;;
    cleanup)
        cleanup
        ;;
    db-generate)
        db_generate
        ;;
    db-migrate)
        db_migrate
        ;;
    db-studio)
        db_studio
        ;;
    help|--help|-h)
        show_help
        ;;
    *)
        echo -e "${RED}❌ Unknown command: $COMMAND${NC}"
        show_help
        exit 1
        ;;
esac