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
    echo "  start-infra        Start only infrastructure services (DB, Vespa, monitoring)"
    echo "  stop               Stop all services"
    echo "  restart            Restart all services"
    echo "  update-app         Update only the main app service (efficient for code changes)"
    echo "  update-sync        Update only the sync server service"
    echo "  update-app-version <version>  Update both app and sync to a specific Docker image tag"
    echo "  update-sync-version <version> Update sync server to a specific Docker image tag"
    echo "  update-infra       Update infrastructure services"
    echo "  bootstrap-keycloak Bootstrap Keycloak realm/client and Xyne admin user"
    echo "  logs [service]     Show logs for all services or specific service"
    echo "  status             Show status of all services"
    echo "  cleanup            Clean up old containers and images"
    echo "  db-generate        Generate new database migrations (run after schema changes)"
    echo "  db-migrate         Apply pending database migrations"
    echo "  db-studio          Open Drizzle Studio for database management"
    echo "  revert <tag>       Revert app to a specific Docker image tag without rebuilding"
    echo "  help               Show this help message"
    echo ""
    echo "Options:"
    echo "  --force-gpu        Force GPU mode even if GPU not detected"
    echo "  --force-cpu        Force CPU-only mode even if GPU detected"
    echo ""
    echo "Environment Variables:"
    echo "  XYNE_DATA_DIR      Data directory path (default: ./data)"
    echo "                     Example: XYNE_DATA_DIR=../xyne-data ./deploy.sh start"
    echo ""
    echo "Examples:"
    echo "  $0 start           # Start all services (auto-detect GPU/CPU)"
    echo "  $0 start-infra     # Start only infrastructure for local development"
    echo "  $0 start --force-cpu    # Force CPU-only mode"
    echo "  $0 update-app      # Quick main app update without touching other services"
    echo "  $0 update-sync     # Quick sync server update without touching other services"
    echo "  $0 bootstrap-keycloak  # Run Keycloak bootstrap without starting the full app"
    echo "  $0 logs app        # Show app logs"
    echo "  $0 db-generate     # Generate migrations after schema changes"
    echo "  $0 db-migrate      # Apply pending migrations"
    echo "  $0 revert v1.2.3   # Revert app to Docker image tag v1.2.3"
    echo "  XYNE_DATA_DIR=../xyne-data $0 start  # Use existing data directory"
}

detect_gpu_support() {
    # Check if GPU support should be forced
    if [ "$FORCE_GPU" = "true" ]; then
        echo -e "${YELLOW}GPU mode forced via --force-gpu flag${NC}"
        return 0
    fi
    
    if [ "$FORCE_CPU" = "true" ]; then
        echo -e "${YELLOW}CPU-only mode forced via --force-cpu flag${NC}"
        return 1
    fi
    
    # Auto-detect GPU support
    echo -e "${YELLOW}🔍 Detecting GPU support...${NC}"
    
    # Check for NVIDIA GPU and Docker GPU runtime
    if command -v nvidia-smi >/dev/null 2>&1; then
        if nvidia-smi >/dev/null 2>&1; then
            echo -e "${GREEN}NVIDIA GPU detected${NC}"
            
            # Check for Docker GPU runtime
            if docker info 2>/dev/null | grep -i nvidia >/dev/null 2>&1; then
                echo -e "${GREEN}Docker GPU runtime detected${NC}"
                return 0
            else
                echo -e "${YELLOW}WARNING: NVIDIA GPU found but Docker GPU runtime not available${NC}"
                echo -e "${BLUE}INFO: Install NVIDIA Container Toolkit for GPU acceleration${NC}"
                return 1
            fi
        fi
    fi
    
    # Check for Apple Silicon or other non-NVIDIA systems
    if [ "$(uname -m)" = "arm64" ] && [ "$(uname -s)" = "Darwin" ]; then
        echo -e "${BLUE}INFO: Apple Silicon detected - using CPU-only mode${NC}"
        return 1
    fi
    
    echo -e "${BLUE}INFO: No compatible GPU detected - using CPU-only mode${NC}"
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

# Initialize data directory from environment or use default
DATA_DIR="${XYNE_DATA_DIR:-./data}"

# Detect Docker Compose command (docker-compose vs docker compose)
get_docker_compose_cmd() {
    if docker compose version >/dev/null 2>&1; then
        echo "docker compose"
    elif command -v docker-compose >/dev/null 2>&1; then
        echo "docker-compose"
    else
        echo -e "${RED}ERROR: Neither 'docker-compose' nor 'docker compose' is available${NC}"
        exit 1
    fi
}

setup_environment() {
    echo -e "${YELLOW} Setting up environment...${NC}"

    # Create necessary directories with proper permissions
    echo " Creating data directories..."
    mkdir -p "$DATA_DIR"/{postgres-data,vespa-data,app-uploads,app-logs,app-assets,app-migrations,app-downloads,grafana-storage,loki-data,promtail-data,prometheus-data,ollama-data,vespa-models}

    # Create Vespa tmp directory
    mkdir -p "$DATA_DIR"/vespa-data/tmp
    
    # Set proper permissions for services
    echo " Setting up permissions..."
    chmod -f 755 "$DATA_DIR" 2>/dev/null || true
    chmod -f 755 "$DATA_DIR"/* 2>/dev/null || true
    chmod -f 755 "$DATA_DIR"/vespa-data/tmp 2>/dev/null || true
    
    # Copy env template if .env doesn't exist
    if [ ! -f .env ] && [ -f .env.example ]; then
        echo " Copying .env.example to .env..."
        cp .env.example .env
    elif [ ! -f .env ] && [ -f .env.default ]; then
        echo " Copying .env.default to .env..."
        cp .env.default .env
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

    persist_env_if_missing "ENCRYPTION_KEY" "$(generate_secret)"
    persist_env_if_missing "JWT_SECRET" "$(generate_secret)"
    persist_env_if_missing "SERVICE_ACCOUNT_ENCRYPTION_KEY" "$(generate_secret)"
    
    # Create network if it doesn't exist
    docker network create xyne 2>/dev/null || echo "Network 'xyne' already exists"

    # Process prometheus configuration template
    echo " Processing prometheus configuration template..."
    if [ -f prometheus-selfhosted.yml.template ]; then
        # Load environment variables if .env exists
        if [ -f .env ]; then
            set -a && source .env && set +a
        fi

        # Set default METRICS_PORT if not defined
        METRICS_PORT=${METRICS_PORT:-3001}
        export METRICS_PORT

        envsubst < prometheus-selfhosted.yml.template > prometheus-selfhosted.yml
        echo " Prometheus configuration updated with METRICS_PORT=${METRICS_PORT}"
    else
        echo " Template file not found, using existing prometheus-selfhosted.yml"
    fi
}

setup_permissions() {
    echo -e "${YELLOW} Setting directory permissions using Docker containers...${NC}"

    # Set UID and GID to 1000 to avoid permission issues
    USER_UID="1000"
    USER_GID="1000"

    # Directories that need standard 1000:1000 ownership
    STANDARD_DIRS=(
        "postgres-data"
        "vespa-data"
        "vespa-models"
        "app-uploads"
        "app-logs"
        "app-assets"
        "app-migrations"
        "app-downloads"
        "grafana-storage"
        "ollama-data"
    )

    # Use busybox containers to set permissions without requiring sudo
    for dir in "${STANDARD_DIRS[@]}"; do
        docker run --rm -v "$(pwd)/$DATA_DIR/$dir:/data" busybox chown -R "$USER_UID:$USER_GID" /data 2>/dev/null || true
    done

    # Special directories with custom ownership requirements
    docker run --rm -v "$(pwd)/$DATA_DIR/prometheus-data:/data" busybox sh -c 'mkdir -p /data && chown -R 65534:65534 /data' 2>/dev/null || true
    docker run --rm -v "$(pwd)/$DATA_DIR/loki-data:/data" busybox sh -c 'mkdir -p /data && chown -R 10001:10001 /data' 2>/dev/null || true
    docker run --rm -v "$(pwd)/$DATA_DIR/promtail-data:/data" busybox sh -c 'mkdir -p /data && chown -R 10001:10001 /data' 2>/dev/null || true

    echo -e "${GREEN} Permissions configured${NC}"
}

wait_for_postgres() {
    load_env_file
    local attempts=0
    local max_attempts=30
    local postgres_user
    postgres_user=$(get_postgres_probe_user)
    local postgres_db
    postgres_db=$(get_postgres_probe_database)

    echo -e "${YELLOW} Waiting for PostgreSQL to become healthy...${NC}"
    until docker exec xyne-db pg_isready -U "$postgres_user" -d "$postgres_db" >/dev/null 2>&1; do
        attempts=$((attempts + 1))
        if [ "$attempts" -ge "$max_attempts" ]; then
            echo -e "${RED}ERROR: PostgreSQL did not become ready in time${NC}"
            exit 1
        fi
        sleep 2
    done

    echo -e "${GREEN} PostgreSQL is ready${NC}"
}

load_env_file() {
    if [ -f .env ]; then
        set -a
        # shellcheck disable=SC1091
        source .env
        set +a
    fi
}

require_env_value() {
    local key=$1
    if [ -z "${!key:-}" ]; then
        echo -e "${RED}ERROR: ${key} must be set in .env or the environment${NC}" >&2
        exit 1
    fi
}

get_database_url_username() {
    local database_url="${DATABASE_URL:-}"
    if [ -z "$database_url" ]; then
        return 1
    fi

    local credentials="${database_url#*://}"
    local username="${credentials%%[:@]*}"
    if [ -z "$username" ] || [ "$username" = "$credentials" ]; then
        return 1
    fi

    printf "%s" "$username"
}

get_database_url_database() {
    local database_url="${DATABASE_URL:-}"
    if [ -z "$database_url" ]; then
        return 1
    fi

    local database="${database_url##*/}"
    database="${database%%[?]*}"
    if [ -z "$database" ] || [ "$database" = "$database_url" ]; then
        return 1
    fi

    printf "%s" "$database"
}

get_postgres_probe_user() {
    if [ -n "${KC_DB_USERNAME:-}" ]; then
        printf "%s" "$KC_DB_USERNAME"
        return
    fi
    if [ -n "${POSTGRES_USER:-}" ]; then
        printf "%s" "$POSTGRES_USER"
        return
    fi

    local database_url_username
    database_url_username=$(get_database_url_username || true)
    if [ -n "$database_url_username" ]; then
        printf "%s" "$database_url_username"
        return
    fi

    echo -e "${RED}ERROR: Set KC_DB_USERNAME, POSTGRES_USER, or DATABASE_URL before starting PostgreSQL${NC}" >&2
    exit 1
}

get_postgres_probe_database() {
    if [ -n "${POSTGRES_DB:-}" ]; then
        printf "%s" "$POSTGRES_DB"
        return
    fi

    local database_url_database
    database_url_database=$(get_database_url_database || true)
    if [ -n "$database_url_database" ]; then
        printf "%s" "$database_url_database"
        return
    fi

    echo -e "${RED}ERROR: Set POSTGRES_DB or DATABASE_URL before starting PostgreSQL${NC}" >&2
    exit 1
}

is_keycloak_enabled() {
    load_env_file
    [ "${KEYCLOAK_WEB_ENABLED:-false}" = "true" ]
}

generate_secret() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -base64 32 | tr -d '\n'
    else
        dd if=/dev/urandom bs=32 count=1 2>/dev/null | base64 | tr -d '\n'
    fi
}

env_value_is_empty() {
    local key=$1
    local line
    line=$(grep -E "^${key}=" .env 2>/dev/null | tail -n 1 || true)
    if [ -z "$line" ]; then
        return 0
    fi

    local value="${line#*=}"
    value="${value%$'\r'}"
    [ -z "$value" ] || [ "$value" = '""' ] || [ "$value" = "''" ]
}

is_local_url() {
    case "$1" in
        http://localhost*|https://localhost*|http://127.0.0.1*|https://127.0.0.1*)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

persist_env_if_missing() {
    local key=$1
    local value=$2

    touch .env
    if env_value_is_empty "$key"; then
        if grep -q -E "^${key}=" .env 2>/dev/null; then
            awk -v key="$key" -v value="$value" '
                BEGIN { updated = 0 }
                $0 ~ "^" key "=" && updated == 0 {
                    print key "=" value
                    updated = 1
                    next
                }
                { print }
            ' .env > .env.tmp && mv .env.tmp .env
        else
            echo "${key}=${value}" >> .env
        fi
        echo " Persisted ${key} in .env"
    fi
}

ensure_keycloak_bootstrap_env() {
    if ! is_keycloak_enabled; then
        return
    fi

    load_env_file
    local required_keys=(
        "HOST"
        "KEYCLOAK_PUBLIC_BASE_URL"
        "KEYCLOAK_INTERNAL_BASE_URL"
        "KEYCLOAK_REALM"
        "KEYCLOAK_CLIENT_ID"
        "KEYCLOAK_LOGOUT_REDIRECT_URL"
        "KEYCLOAK_WORKSPACE_EXTERNAL_ID"
        "XYNE_BOOTSTRAP_ADMIN_EMAIL"
        "XYNE_BOOTSTRAP_ADMIN_NAME"
        "XYNE_BOOTSTRAP_WORKSPACE_NAME"
        "XYNE_BOOTSTRAP_WORKSPACE_DOMAIN"
        "KEYCLOAK_BOOTSTRAP_RESET_ADMIN_PASSWORD"
        "KEYCLOAK_CLIENT_SECRET"
        "XYNE_BOOTSTRAP_ADMIN_PASSWORD"
    )
    local key
    for key in "${required_keys[@]}"; do
        require_env_value "$key"
    done

    validate_keycloak_bootstrap_env
}

validate_keycloak_bootstrap_env() {
    load_env_file

    if is_local_url "${KEYCLOAK_INTERNAL_BASE_URL:-}"; then
        echo -e "${RED}ERROR: KEYCLOAK_INTERNAL_BASE_URL=${KEYCLOAK_INTERNAL_BASE_URL}${NC}"
        echo -e "${RED}Portable bootstrap runs inside the app container, so localhost points at the app container, not Keycloak.${NC}"
        echo -e "${RED}Use KEYCLOAK_INTERNAL_BASE_URL=http://keycloak:8080 for the bundled Keycloak service.${NC}"
        exit 1
    fi

    if is_local_url "${HOST:-}"; then
        echo -e "${YELLOW}WARNING: HOST=${HOST}. For sbx/prod, set HOST to the public HTTPS Xyne origin before bootstrapping.${NC}"
    fi

    if is_local_url "${KEYCLOAK_PUBLIC_BASE_URL:-}"; then
        echo -e "${YELLOW}WARNING: KEYCLOAK_PUBLIC_BASE_URL=${KEYCLOAK_PUBLIC_BASE_URL}. For sbx/prod, set it to the public HTTPS Keycloak origin before bootstrapping.${NC}"
    fi

    if [ "${KEYCLOAK_ADMIN:-}" = "admin" ] && [ "${KEYCLOAK_ADMIN_PASSWORD:-}" = "admin" ]; then
        echo -e "${YELLOW}WARNING: Keycloak admin credentials are still admin/admin. Change KEYCLOAK_ADMIN_PASSWORD for sbx/prod before first Keycloak startup.${NC}"
    fi
}

wait_for_keycloak() {
    load_env_file
    local attempts=0
    local max_attempts=60
    local keycloak_port="${KEYCLOAK_PORT:-8082}"
    local keycloak_path=""
    if [[ "${KEYCLOAK_PUBLIC_BASE_URL:-}" == */keycloak* ]]; then
        keycloak_path="/keycloak"
    fi
    local endpoint="http://localhost:${keycloak_port}${keycloak_path}/realms/master"

    if ! command -v curl >/dev/null 2>&1; then
        echo -e "${RED}ERROR: curl is required to wait for Keycloak at ${endpoint}${NC}"
        exit 1
    fi

    echo -e "${YELLOW} Waiting for Keycloak to become ready...${NC}"
    until curl -fsS "$endpoint" >/dev/null 2>&1; do
        attempts=$((attempts + 1))
        if [ "$attempts" -ge "$max_attempts" ]; then
            echo -e "${RED}ERROR: Keycloak did not become ready in time at ${endpoint}${NC}"
            exit 1
        fi
        sleep 2
    done

    echo -e "${GREEN} Keycloak is ready${NC}"
}

ensure_keycloak_database() {
    load_env_file
    require_env_value "KC_DB_USERNAME"

    echo -e "${YELLOW} Ensuring Keycloak database exists...${NC}"

    if docker exec -e PGPASSWORD="${KC_DB_PASSWORD:-}" xyne-db psql -U "$KC_DB_USERNAME" -tAc "SELECT 1 FROM pg_database WHERE datname = 'keycloak'" | grep -q "1"; then
        echo -e "${GREEN} Keycloak database already exists${NC}"
        return
    fi

    docker exec -e PGPASSWORD="${KC_DB_PASSWORD:-}" xyne-db psql -U "$KC_DB_USERNAME" -c "CREATE DATABASE keycloak;"
    echo -e "${GREEN} Keycloak database created${NC}"
}

stop_keycloak_if_disabled() {
    if is_keycloak_enabled; then
        return
    fi

    INFRA_COMPOSE=${INFRA_COMPOSE:-$(get_infrastructure_compose)}
    DOCKER_COMPOSE=${DOCKER_COMPOSE:-$(get_docker_compose_cmd)}
    $DOCKER_COMPOSE -f docker-compose.yml -f "$INFRA_COMPOSE" stop keycloak >/dev/null 2>&1 || true
}

start_infrastructure() {
    echo -e "${YELLOW}  Starting infrastructure services...${NC}"

    # Determine which infrastructure compose file to use
    INFRA_COMPOSE=$(get_infrastructure_compose)
    if detect_gpu_support >/dev/null 2>&1; then
        echo -e "${GREEN} Using GPU-accelerated Vespa${NC}"
    else
        echo -e "${BLUE} Using CPU-only Vespa${NC}"
    fi

    DOCKER_COMPOSE=$(get_docker_compose_cmd)
    $DOCKER_COMPOSE -f docker-compose.yml -f "$INFRA_COMPOSE" up -d xyne-db
    wait_for_postgres
    if is_keycloak_enabled; then
        ensure_keycloak_database
        $DOCKER_COMPOSE -f docker-compose.yml -f "$INFRA_COMPOSE" --profile keycloak up -d --build
        wait_for_keycloak
    else
        stop_keycloak_if_disabled
        $DOCKER_COMPOSE -f docker-compose.yml -f "$INFRA_COMPOSE" up -d --build
    fi
    echo -e "${GREEN} Infrastructure services started${NC}"
}

prepare_app_images() {
    COMPOSE_FILES=$(get_compose_files)
    DOCKER_COMPOSE=$(get_docker_compose_cmd)

    if [ "$APP_DEPLOY_MODE" = "build" ]; then
        echo -e "${BLUE}Building app locally (no pull)...${NC}"
        $DOCKER_COMPOSE $COMPOSE_FILES build app
        echo -e "${BLUE}Building sync server locally (no pull)...${NC}"
        $DOCKER_COMPOSE $COMPOSE_FILES build app-sync
    elif [ "$APP_DEPLOY_MODE" = "version" ]; then
        echo -e "${BLUE}Pulling prebuilt app images...${NC}"
        $DOCKER_COMPOSE $COMPOSE_FILES pull app app-sync
    fi

    APP_IMAGES_PREPARED=true
}

start_app() {
    echo -e "${YELLOW}Starting application services...${NC}"

    COMPOSE_FILES=$(get_compose_files)
    DOCKER_COMPOSE=$(get_docker_compose_cmd)

    if [ "$APP_DEPLOY_MODE" = "build" ]; then
        if [ "${APP_IMAGES_PREPARED:-false}" != "true" ]; then
            prepare_app_images
        fi
        echo -e "${BLUE}Starting services with locally built images...${NC}"
        $DOCKER_COMPOSE $COMPOSE_FILES up -d --force-recreate app app-sync
    elif [ "$APP_DEPLOY_MODE" = "version" ]; then
        if [ "${APP_IMAGES_PREPARED:-false}" != "true" ]; then
            prepare_app_images
        fi
        echo -e "${BLUE}Starting services with prebuilt images...${NC}"
        $DOCKER_COMPOSE $COMPOSE_FILES up -d app
        $DOCKER_COMPOSE $COMPOSE_FILES up -d app-sync
    else
        $DOCKER_COMPOSE $COMPOSE_FILES up -d app
        $DOCKER_COMPOSE $COMPOSE_FILES up -d app-sync
    fi

    echo -e "${GREEN}Application services started${NC}"
}


get_infrastructure_compose() {
    if detect_gpu_support >/dev/null 2>&1; then
        echo "docker-compose.infrastructure.yml"
    else
        echo "docker-compose.infrastructure-cpu.yml"
    fi
}

get_compose_files() {
    local files="-f docker-compose.yml"
    local infra_compose=$(get_infrastructure_compose)
    files="$files -f $infra_compose"

    # Add app compose file
    files="$files -f docker-compose.app.yml"

    # Add sync compose file
    files="$files -f docker-compose.sync.yml"

    echo "$files"
}

get_app_compose_files() {
    local files="-f docker-compose.yml"
    local infra_compose=$(get_infrastructure_compose)
    files="$files -f $infra_compose"
    files="$files -f docker-compose.app.yml"
    echo "$files"
}

get_sync_compose_files() {
    local files="-f docker-compose.yml"
    local infra_compose=$(get_infrastructure_compose)
    files="$files -f $infra_compose"
    files="$files -f docker-compose.sync.yml"
    echo "$files"
}

ensure_app_compose_selected_for_bootstrap() {
    if [ -f docker-compose.app.yml ]; then
        return
    fi

    echo -e "${BLUE}No selected app compose file found; using build compose for bootstrap${NC}"
    cp docker-compose.app-build.yml docker-compose.app.yml
    if [ ! -f docker-compose.sync.yml ]; then
        cp docker-compose.sync-build.yml docker-compose.sync.yml
    fi
    APP_DEPLOY_MODE="build"
}

app_image_available_for_bootstrap() {
    if [ ! -f docker-compose.app.yml ]; then
        return 1
    fi

    local image
    image=$(awk '/^[[:space:]]*image:/ {print $2; exit}' docker-compose.app.yml)
    image="${image:-xynehq/xyne}"
    [ -n "$image" ] && docker image inspect "$image" >/dev/null 2>&1
}

prepare_keycloak_bootstrap_app_image() {
    ensure_app_compose_selected_for_bootstrap

    COMPOSE_FILES=$(get_app_compose_files)
    DOCKER_COMPOSE=$(get_docker_compose_cmd)
    if grep -q "build:" docker-compose.app.yml; then
        echo -e "${BLUE}Building app image for Keycloak bootstrap...${NC}"
        $DOCKER_COMPOSE $COMPOSE_FILES build app
    elif ! app_image_available_for_bootstrap; then
        echo -e "${BLUE}Pulling app image for Keycloak bootstrap...${NC}"
        $DOCKER_COMPOSE $COMPOSE_FILES pull app
    fi
}

run_app_migrations() {
    COMPOSE_FILES=$(get_app_compose_files)
    DOCKER_COMPOSE=$(get_docker_compose_cmd)
    echo -e "${YELLOW} Running app database migrations...${NC}"
    $DOCKER_COMPOSE $COMPOSE_FILES run --rm --no-deps app bun run migrate
    echo -e "${GREEN} App database migrations completed${NC}"
}

run_keycloak_bootstrap() {
    if ! is_keycloak_enabled; then
        echo "Skipping Keycloak bootstrap"
        return
    fi

    ensure_keycloak_bootstrap_env
    COMPOSE_FILES=$(get_app_compose_files)
    DOCKER_COMPOSE=$(get_docker_compose_cmd)
    echo -e "${YELLOW} Running Keycloak bootstrap...${NC}"
    $DOCKER_COMPOSE $COMPOSE_FILES run --rm --no-deps app bun run keycloak:bootstrap
    echo -e "${GREEN} Keycloak bootstrap completed${NC}"
}

bootstrap_keycloak() {
    setup_environment
    if ! is_keycloak_enabled; then
        echo "Skipping Keycloak bootstrap"
        return
    fi

    INFRA_COMPOSE=$(get_infrastructure_compose)
    DOCKER_COMPOSE=$(get_docker_compose_cmd)
    $DOCKER_COMPOSE -f docker-compose.yml -f "$INFRA_COMPOSE" up -d xyne-db
    wait_for_postgres
    ensure_keycloak_database
    $DOCKER_COMPOSE -f docker-compose.yml -f "$INFRA_COMPOSE" --profile keycloak up -d keycloak
    wait_for_keycloak
    ensure_keycloak_bootstrap_env
    prepare_keycloak_bootstrap_app_image
    run_app_migrations
    run_keycloak_bootstrap
}

stop_all() {
    echo -e "${YELLOW} Stopping all services...${NC}"
    COMPOSE_FILES=$(get_compose_files)
    DOCKER_COMPOSE=$(get_docker_compose_cmd)
    $DOCKER_COMPOSE $COMPOSE_FILES --profile keycloak down
    echo -e "${GREEN} All services stopped${NC}"
}

update_app() {
    echo -e "${YELLOW} Updating main application service only...${NC}"

    COMPOSE_FILES=$(get_app_compose_files)
    DOCKER_COMPOSE=$(get_docker_compose_cmd)

    # Build new image for production
    echo "  Building new app image..."
    $DOCKER_COMPOSE $COMPOSE_FILES build app

    # Stop and recreate app service
    echo " Recreating main app service..."
    $DOCKER_COMPOSE $COMPOSE_FILES up -d --force-recreate app

    echo -e "${GREEN} Main application service updated successfully${NC}"
    echo -e "${BLUE}  Database, Vespa, and Sync services were not affected${NC}"
}

update_sync() {
    echo -e "${YELLOW} Updating sync server service only...${NC}"

    COMPOSE_FILES=$(get_sync_compose_files)
    DOCKER_COMPOSE=$(get_docker_compose_cmd)

    # Build new image for production
    echo "  Building new sync image..."
    $DOCKER_COMPOSE $COMPOSE_FILES build app-sync

    # Stop and recreate sync service
    echo " Recreating sync server..."
    $DOCKER_COMPOSE $COMPOSE_FILES up -d --force-recreate app-sync

    echo -e "${GREEN} Sync server service updated successfully${NC}"
    echo -e "${BLUE}  Database, Vespa, and main app services were not affected${NC}"
}

update_infrastructure() {
    echo -e "${YELLOW} Updating infrastructure services...${NC}"
    INFRA_COMPOSE=$(get_infrastructure_compose)

    # Setup environment and permissions first
    setup_environment
    setup_permissions

    # Pull images that are available in registries (ignore failures for custom builds)
    DOCKER_COMPOSE=$(get_docker_compose_cmd)
    $DOCKER_COMPOSE -f docker-compose.yml -f "$INFRA_COMPOSE" pull || echo -e "${YELLOW}Some images require building (this is normal for custom images)${NC}"

    $DOCKER_COMPOSE -f docker-compose.yml -f "$INFRA_COMPOSE" up -d xyne-db
    wait_for_postgres

    # Build and start all services (--build will handle custom images)
    if is_keycloak_enabled; then
        ensure_keycloak_database
        $DOCKER_COMPOSE -f docker-compose.yml -f "$INFRA_COMPOSE" --profile keycloak up -d --force-recreate --build
        wait_for_keycloak
    else
        stop_keycloak_if_disabled
        $DOCKER_COMPOSE -f docker-compose.yml -f "$INFRA_COMPOSE" up -d --force-recreate --build
    fi
    echo -e "${GREEN} Infrastructure services updated${NC}"
}

show_logs() {
    local service=$1
    COMPOSE_FILES=$(get_compose_files)
    DOCKER_COMPOSE=$(get_docker_compose_cmd)
    if [ -n "$service" ]; then
        echo -e "${YELLOW} Showing logs for $service...${NC}"
        $DOCKER_COMPOSE $COMPOSE_FILES logs -f "$service"
    else
        echo -e "${YELLOW} Showing logs for all services...${NC}"
        $DOCKER_COMPOSE $COMPOSE_FILES logs -f
    fi
}

show_status() {
    echo -e "${YELLOW} Service Status:${NC}"
    COMPOSE_FILES=$(get_compose_files)
    DOCKER_COMPOSE=$(get_docker_compose_cmd)
    $DOCKER_COMPOSE $COMPOSE_FILES ps
    echo ""
    echo -e "${YELLOW} Access URLs:${NC}"
    echo "  • Xyne Application: http://localhost:3000"
    echo "  • Xyne Sync Server: http://localhost:3010"
    echo "  • Grafana: http://localhost:3002"
    echo "  • Prometheus: http://localhost:9090"
    echo "  • Loki: http://localhost:3100"
    if is_keycloak_enabled; then
        echo "  • Keycloak: http://localhost:8082"
    fi
    echo "  • LiveKit Server: http://localhost:7880 (WebRTC: 7881, UDP: 7882)"
    echo -e "${GREEN}  • Application Mode: Production${NC}"
    # Show GPU/CPU mode
    if detect_gpu_support >/dev/null 2>&1; then
        echo -e "${GREEN}  • Vespa Mode: GPU-accelerated${NC}"
    else
        echo -e "${BLUE}  • Vespa Mode: CPU-only${NC}"
    fi
}

cleanup() {
    echo -e "${YELLOW} Cleaning up old containers and images...${NC}"
    docker system prune -f
    docker volume prune -f
    echo -e "${GREEN} Cleanup completed${NC}"
}

db_generate() {
    echo -e "${YELLOW}  Generating database migrations...${NC}"

    # Check if main app is running
    COMPOSE_FILES=$(get_compose_files)
    DOCKER_COMPOSE=$(get_docker_compose_cmd)
    if ! $DOCKER_COMPOSE $COMPOSE_FILES ps | grep -q "xyne-app.*Up"; then
        echo -e "${RED} Main app service is not running. Start with: ./deploy.sh start${NC}"
        exit 1
    fi

    # Run drizzle generate inside the container
    $DOCKER_COMPOSE $COMPOSE_FILES exec app bun run generate

    echo -e "${GREEN} Migrations generated and saved to ./data/app-migrations/${NC}"
    echo -e "${BLUE}  Generated migrations will persist across container updates${NC}"
}

db_migrate() {
    echo -e "${YELLOW}  Applying database migrations...${NC}"

    # Check if main app is running
    COMPOSE_FILES=$(get_compose_files)
    DOCKER_COMPOSE=$(get_docker_compose_cmd)
    if ! $DOCKER_COMPOSE $COMPOSE_FILES ps | grep -q "xyne-app.*Up"; then
        echo -e "${RED} Main app service is not running. Start with: ./deploy.sh start${NC}"
        exit 1
    fi

    # Run drizzle migrate inside the container
    $DOCKER_COMPOSE $COMPOSE_FILES exec app bun run migrate

    echo -e "${GREEN} Database migrations applied successfully${NC}"
}

db_studio() {
    echo -e "${YELLOW}  Opening Drizzle Studio...${NC}"
    echo -e "${BLUE}  Drizzle Studio will be available at: http://localhost:4983${NC}"
    echo -e "${BLUE}  Press Ctrl+C to stop Drizzle Studio${NC}"

    # Check if main app is running
    COMPOSE_FILES=$(get_compose_files)
    DOCKER_COMPOSE=$(get_docker_compose_cmd)
    if ! $DOCKER_COMPOSE $COMPOSE_FILES ps | grep -q "xyne-app.*Up"; then
        echo -e "${RED} Main app service is not running. Start with: ./deploy.sh start${NC}"
        exit 1
    fi

    # Run drizzle studio in a new container with port forwarding
    $DOCKER_COMPOSE $COMPOSE_FILES run -p 4983:4983 app bun drizzle-kit studio
}

revert_app() {
    local target_tag=$1
    
    if [ -z "$target_tag" ]; then
        echo -e "${RED}ERROR: No image tag specified${NC}"
        echo "Usage: $0 revert <tag>"
        echo "Example: $0 revert v1.2.3"
        exit 1
    fi

    IMAGE_NAME="xynehq/xyne"

    echo -e "${YELLOW}Reverting application to image tag: $target_tag${NC}"
    
    # Check if the image exists locally or can be pulled
    if ! docker image inspect "$IMAGE_NAME:$target_tag" >/dev/null 2>&1; then
        echo -e "${YELLOW}Image $IMAGE_NAME:$target_tag not found locally, attempting to pull...${NC}"
        if ! docker pull "$IMAGE_NAME:$target_tag" 2>/dev/null; then
            echo -e "${RED}ERROR: Failed to pull image $IMAGE_NAME:$target_tag${NC}"
            echo "Available local images:"
            docker images $IMAGE_NAME --format "table {{.Repository}}\t{{.Tag}}\t{{.CreatedAt}}\t{{.Size}}"
            exit 1
        fi
    fi
    
    # Tag the target image as 'latest' for docker-compose
    echo -e "${YELLOW}Tagging $IMAGE_NAME:$target_tag as $IMAGE_NAME:latest${NC}"
    docker tag "$IMAGE_NAME:$target_tag" "$IMAGE_NAME:latest"
    
    # Stop and recreate both app services with the reverted image
    COMPOSE_FILES=$(get_compose_files)
    DOCKER_COMPOSE=$(get_docker_compose_cmd)
    echo -e "${YELLOW}Stopping current app services${NC}"
    $DOCKER_COMPOSE $COMPOSE_FILES stop app app-sync

    echo -e "${YELLOW}Starting main app service with reverted image${NC}"
    $DOCKER_COMPOSE $COMPOSE_FILES up -d --force-recreate app

    echo -e "${YELLOW}Starting sync server with reverted image${NC}"
    $DOCKER_COMPOSE $COMPOSE_FILES up -d --force-recreate app-sync
    
    echo -e "${GREEN}Application successfully reverted to tag: $target_tag${NC}"
    echo -e "${BLUE}INFO: Database and Vespa services were not affected${NC}"
    
    # Show status
    show_status
}

# Update both app and app-sync to a given version
update_app_version() {
    local target_tag=$1
    if [ -z "$target_tag" ]; then
        echo -e "${RED}ERROR: No image tag specified${NC}"
        echo "Usage: $0 update-app-version <tag>"
        echo "Example: $0 update-app-version 1.2.3"
        exit 1
    fi

    echo -e "${YELLOW}Updating app and sync to image tag: $target_tag${NC}"

    IMAGE_NAME="xynehq/xyne"

    # Check if the image exists locally or can be pulled
    if ! docker image inspect "$IMAGE_NAME:$target_tag" >/dev/null 2>&1; then
        echo -e "${YELLOW}Image $IMAGE_NAME:$target_tag not found locally, attempting to pull...${NC}"
        if ! docker pull "$IMAGE_NAME:$target_tag" 2>/dev/null; then
            echo -e "${RED}ERROR: Failed to pull image $IMAGE_NAME:$target_tag${NC}"
            echo "Available local images:"
            docker images $IMAGE_NAME --format "table {{.Repository}}\t{{.Tag}}\t{{.CreatedAt}}\t{{.Size}}"
            exit 1
        fi
    fi

    # Tag the target image as 'latest' for docker-compose
    echo -e "${YELLOW}Tagging $IMAGE_NAME:$target_tag as $IMAGE_NAME:latest${NC}"
    docker tag "$IMAGE_NAME:$target_tag" "$IMAGE_NAME:latest"

    # Stop and recreate both app services with the new image
    COMPOSE_FILES=$(get_compose_files)
    DOCKER_COMPOSE=$(get_docker_compose_cmd)
    echo -e "${YELLOW}Stopping current app services${NC}"
    $DOCKER_COMPOSE $COMPOSE_FILES stop app app-sync

    echo -e "${YELLOW}Starting main app service with new image${NC}"
    $DOCKER_COMPOSE $COMPOSE_FILES up -d --force-recreate app

    echo -e "${YELLOW}Starting sync server with new image${NC}"
    $DOCKER_COMPOSE $COMPOSE_FILES up -d --force-recreate app-sync

    echo -e "${GREEN}App and sync server updated to tag: $target_tag${NC}"
    echo -e "${BLUE}INFO: Database and Vespa services were not affected${NC}"

    # Show status
    show_status
}

# Update only app-sync to a given version
update_sync_version() {
    local target_tag=$1
    if [ -z "$target_tag" ]; then
        echo -e "${RED}ERROR: No image tag specified${NC}"
        echo "Usage: $0 update-sync-version <tag>"
        echo "Example: $0 update-sync-version 1.2.3"
        exit 1
    fi

    echo -e "${YELLOW}Updating sync server to image tag: $target_tag${NC}"

    IMAGE_NAME="xynehq/xyne"
    # Check if the image exists locally or can be pulled
    if ! docker image inspect "$IMAGE_NAME:$target_tag" >/dev/null 2>&1; then
        echo -e "${YELLOW}Image $IMAGE_NAME:$target_tag not found locally, attempting to pull...${NC}"
        if ! docker pull "$IMAGE_NAME:$target_tag" 2>/dev/null; then
            echo -e "${RED}ERROR: Failed to pull image $IMAGE_NAME:$target_tag${NC}"
            echo "Available local images:"
            docker images $IMAGE_NAME --format "table {{.Repository}}\t{{.Tag}}\t{{.CreatedAt}}\t{{.Size}}"
            exit 1
        fi
    fi

    # Tag the target image as 'latest' for docker-compose
    echo -e "${YELLOW}Tagging $IMAGE_NAME:$target_tag as $IMAGE_NAME:latest${NC}"
    docker tag "$IMAGE_NAME:$target_tag" "$IMAGE_NAME:latest"

    # Stop and recreate only app-sync service with the new image
    COMPOSE_FILES=$(get_compose_files)
    DOCKER_COMPOSE=$(get_docker_compose_cmd)
    echo -e "${YELLOW}Stopping sync server${NC}"
    $DOCKER_COMPOSE $COMPOSE_FILES stop app-sync

    echo -e "${YELLOW}Starting sync server with new image${NC}"
    $DOCKER_COMPOSE $COMPOSE_FILES up -d --force-recreate app-sync

    echo -e "${GREEN}Sync server updated to tag: $target_tag${NC}"
    echo -e "${BLUE}INFO: Database, Vespa, and main app services were not affected${NC}"

    # Show status
    show_status
}

# Main script logic
case $COMMAND in
    start)
        setup_environment
        setup_permissions
        start_infrastructure
        sleep 10  # Wait for infrastructure to be ready

        echo -e "${YELLOW}Select app deployment mode:${NC}"
        echo "  1) build (default)"
        echo "  2) version"
        read -p "Enter choice [1/2]: " user_choice

        if [ "$user_choice" = "2" ]; then
            APP_DEPLOY_MODE="version"
            echo -e "${BLUE}Using docker-compose.app-version.yml and docker-compose.sync-version.yml${NC}"
            cp docker-compose.app-version.yml docker-compose.app.yml
            cp docker-compose.sync-version.yml docker-compose.sync.yml
        else
            APP_DEPLOY_MODE="build"
            echo -e "${BLUE}Using docker-compose.app-build.yml and docker-compose.sync-build.yml${NC}"
            cp docker-compose.app-build.yml docker-compose.app.yml
            cp docker-compose.sync-build.yml docker-compose.sync.yml
        fi

        prepare_app_images
        if is_keycloak_enabled; then
            ensure_keycloak_bootstrap_env
            run_app_migrations
            run_keycloak_bootstrap
        else
            echo "Skipping Keycloak bootstrap"
        fi
        start_app
        show_status
        ;;

    start-infra)
        setup_environment
        setup_permissions
        start_infrastructure
        echo -e "${GREEN} Infrastructure services started successfully${NC}"
        echo -e "${BLUE} You can now run your application locally in development mode${NC}"
        if is_keycloak_enabled; then
            echo -e "${BLUE} Infrastructure services: PostgreSQL, Keycloak, Vespa, Prometheus, Grafana, Loki${NC}"
            echo -e "${BLUE} Keycloak web login is enabled. Bootstrap it with one of:${NC}"
            echo "  cd ../../server && bun run keycloak:bootstrap"
            echo "  ./deploy.sh bootstrap-keycloak"
        else
            echo -e "${BLUE} Infrastructure services: PostgreSQL, Vespa, Prometheus, Grafana, Loki${NC}"
        fi
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
    update-sync)
        setup_environment
        update_sync
        show_status
        ;;
    update-infra)
        setup_environment
        update_infrastructure
        if is_keycloak_enabled; then
            ensure_keycloak_bootstrap_env
            if app_image_available_for_bootstrap; then
                run_app_migrations
                run_keycloak_bootstrap
            else
                echo -e "${YELLOW}App image is unavailable; run ./deploy.sh bootstrap-keycloak after building or pulling the app image.${NC}"
            fi
        else
            echo "Skipping Keycloak bootstrap"
        fi
        show_status
        ;;
    logs)
        show_logs $1
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
    revert)
        revert_app $1
        ;;
    update-app-version)
        update_app_version $1
        ;;
    update-sync-version)
        update_sync_version $1
        ;;
    bootstrap-keycloak)
        bootstrap_keycloak
        ;;
    help|--help|-h)
        show_help
        ;;
    *)
        echo -e "${RED} Unknown command: $COMMAND${NC}"
        show_help
        exit 1
        ;;
esac
