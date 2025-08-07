#!/bin/bash
set -euo pipefail

# Determine the absolute path of the directory where the script resides
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"

# Assume the project root is one level up from the script's directory (deployment/)
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Change to the project root directory
cd "$PROJECT_ROOT"
echo "Changed working directory to project root: $PROJECT_ROOT"
echo ""

# Script to set up and start Docker Compose services with correct directory permissions.

# Ensure the script is run from the 'deployment' directory or adjust paths accordingly.
# For simplicity, this script assumes it's run from the parent directory of 'deployment/',
# or that paths like '../server/' are valid from the CWD.
# If running from within 'deployment/', paths like './loki' are fine, but '../server/' becomes '../../server/'.
# This script will use paths relative to the 'deployment' directory for docker-compose files,
# and paths relative to the project root (CWD of this script execution) for data directories.

# Production deployment uses ./data/ structure
DEPLOYMENT_DATA_DIR="deployment/data"

# Service-specific settings
LOKI_UID=10001
LOKI_GID=10001
PROMTAIL_UID=10001
PROMTAIL_GID=10001
VESPA_UID=1000
VESPA_GID=1000
GRAFANA_UID=472
GRAFANA_GID=472
PROMETHEUS_UID=65534
PROMETHEUS_GID=65534

# For legacy compatibility
LOKI_DIR_RELATIVE="deployment/loki" # Legacy path
VESPA_DATA_DIR_RELATIVE="server/vespa-data" # Legacy path  
VESPA_LOGS_DIR_RELATIVE="server/vespa-logs" # Legacy path
GRAFANA_STORAGE_DIR_RELATIVE="deployment/grafana/grafana-storage" # Legacy path

# Find Docker Compose files in the current directory (meant to be 'deployment/')
# If script is in deployment/, then 'find . -maxdepth 1 -name'
# If script is in project root, then 'find deployment/ -maxdepth 1 -name'
# Assuming script is run from project root for now, so compose files are in 'deployment/'

echo "Looking for Docker Compose files in ./deployment/ ..."
COMPOSE_FILES=( $(find ./deployment -maxdepth 1 -name 'docker-compose*.yml' -exec basename {} \;) )

if [ ${#COMPOSE_FILES[@]} -eq 0 ]; then
    echo "No Docker Compose files (docker-compose*.yml) found in ./deployment/."
    exit 1
fi

echo "Please select the Docker Compose file to use:"
PS3="Enter number: "
select FILE_BASENAME in "${COMPOSE_FILES[@]}" "Quit"; do
    if [[ "$REPLY" == "Quit" ]] || [[ "$FILE_BASENAME" == "Quit" ]]; then
        echo "Exiting."
        exit 0
    fi
    if [[ -n "$FILE_BASENAME" ]]; then
        SELECTED_COMPOSE_FILE="deployment/$FILE_BASENAME"
        echo "You selected: $SELECTED_COMPOSE_FILE"
        break
    else
        echo "Invalid selection. Please try again."
    fi
done

# --- Ask for GPU support ---
USE_GPU_FLAG=""
COMPOSE_FILES_STRING="-f \"$SELECTED_COMPOSE_FILE\"" # Start with the base file, ensuring -f is present

if [ -f "deployment/docker-compose.gpu.yml" ]; then
    echo ""
    while true; do
        read -p "Do you want to enable GPU support for Vespa? (Requires NVIDIA drivers, NVIDIA Container Toolkit, and the 'xyne/vespa-gpu' Docker image built locally) (y/n): " yn
        case $yn in
            [Yy]* )
                USE_GPU_FLAG="yes"
                # GPU Prerequisites Check
                echo "Performing GPU prerequisite checks..."

                # 1. Check for nvidia-smi (basic GPU presence check)
                if ! command -v nvidia-smi &> /dev/null; then
                    echo "ERROR: 'nvidia-smi' command not found. An NVIDIA GPU and drivers are required for GPU mode."
                    echo "Please install NVIDIA drivers and ensure 'nvidia-smi' is accessible."
                    read -p "Do you want to continue without a functional 'nvidia-smi' (NOT RECOMMENDED)? (y/n): " continue_no_smi
                    if [[ "$continue_no_smi" != [Yy]* ]]; then
                        echo "Aborting GPU setup. Please install NVIDIA drivers or choose CPU mode."
                        exit 1
                    fi
                else
                    if ! nvidia-smi -L &> /dev/null || [[ $(nvidia-smi -L | wc -l) -eq 0 ]]; then
                        echo "ERROR: 'nvidia-smi' is available but does not list any NVIDIA GPUs."
                        echo "Please ensure NVIDIA GPUs are available and drivers are correctly installed."
                        read -p "Do you want to continue without detected GPUs (NOT RECOMMENDED)? (y/n): " continue_no_gpu_listed
                        if [[ "$continue_no_gpu_listed" != [Yy]* ]]; then
                            echo "Aborting GPU setup. Please check GPU/driver installation or choose CPU mode."
                            exit 1
                        fi
                    else
                        echo "NVIDIA GPU(s) detected by nvidia-smi."
                    fi
                fi

                # 2. Check for NVIDIA Container Toolkit
                NVIDIA_TOOLKIT_MARKER="/usr/bin/nvidia-container-cli" # Heuristic check
                if [ ! -f "$NVIDIA_TOOLKIT_MARKER" ]; then
                    echo "WARNING: NVIDIA Container Toolkit marker ($NVIDIA_TOOLKIT_MARKER) not found."
                    echo "The toolkit is required for Docker to use NVIDIA GPUs."
                    if [ -f "deployment/setup-nvidia-toolkit.sh" ]; then
                        read -p "Do you want to attempt to run './deployment/setup-nvidia-toolkit.sh' now? (Requires sudo) (y/n): " run_toolkit_script
                        if [[ "$run_toolkit_script" == [Yy]* ]]; then
                            echo "Attempting to run NVIDIA Container Toolkit setup script..."
                            if sudo ./deployment/setup-nvidia-toolkit.sh; then
                                echo "NVIDIA Container Toolkit setup script completed."
                                echo "IMPORTANT: A system reboot or re-login might be required for all changes to take full effect."
                            else
                                echo "ERROR: NVIDIA Container Toolkit setup script failed. GPU mode for Vespa will likely not work."
                                echo "Please try running it manually or ensure the toolkit is correctly installed."
                                read -p "Do you want to continue despite toolkit setup failure (NOT RECOMMENDED)? (y/n): " continue_toolkit_fail
                                if [[ "$continue_toolkit_fail" != [Yy]* ]]; then
                                    echo "Aborting GPU setup."
                                    exit 1
                                fi
                            fi
                        else
                            echo "Skipping NVIDIA Container Toolkit setup. GPU mode for Vespa may not work without it."
                        fi
                    else
                        echo "NVIDIA Container Toolkit setup script (deployment/setup-nvidia-toolkit.sh) not found."
                        echo "Please install the toolkit manually if you wish to use GPU mode."
                    fi
                else
                    echo "NVIDIA Container Toolkit marker found."
                fi

                # 3. Remind about custom Docker image
                echo "REMINDER: For GPU mode, ensure you have built the 'xyne/vespa-gpu' Docker image."
                echo "Build command (from project root): docker build -t xyne/vespa-gpu -f deployment/Dockerfile-vespa-gpu ."
                echo ""

                COMPOSE_FILES_STRING="$COMPOSE_FILES_STRING -f \"deployment/docker-compose.gpu.yml\""
                echo "GPU support WILL be enabled using $COMPOSE_FILES_STRING."
                break
                ;;
            [Nn]* )
                USE_GPU_FLAG="no"
                echo "GPU support will NOT be enabled. Vespa will run in CPU mode."
                break
                ;;
            * ) echo "Please answer yes (y) or no (n).";;
        esac
    done
else
    echo "GPU override file (deployment/docker-compose.gpu.yml) not found. Proceeding with CPU-only setup for Vespa."
    USE_GPU_FLAG="no"
fi
echo ""
# --- End GPU support question ---

# Detect Docker group ID for Promtail socket access
echo "Detecting Docker group ID for Promtail..."
DOCKER_GROUP_ID=$(getent group docker | cut -d: -f3 2>/dev/null || echo "999")
echo "Docker group ID: $DOCKER_GROUP_ID"

# Set up environment file
echo "Setting up environment variables..."
ENV_FILE="server/.env"
if [ ! -f "$ENV_FILE" ]; then
    echo "Creating basic .env file at $ENV_FILE"
    touch "$ENV_FILE"
fi

# Add Docker environment variables if not present
if ! grep -q "^DOCKER_UID=" "$ENV_FILE" 2>/dev/null; then
    echo "DOCKER_UID=1000" >> "$ENV_FILE"
fi
if ! grep -q "^DOCKER_GID=" "$ENV_FILE" 2>/dev/null; then
    echo "DOCKER_GID=1000" >> "$ENV_FILE"
fi
if ! grep -q "^DOCKER_GROUP_ID=" "$ENV_FILE" 2>/dev/null; then
    echo "DOCKER_GROUP_ID=$DOCKER_GROUP_ID" >> "$ENV_FILE"
fi

# Export for current session
export DOCKER_UID=1000
export DOCKER_GID=1000
export DOCKER_GROUP_ID=$DOCKER_GROUP_ID

# Build the docker-compose command array
docker_compose_cmd_array=("docker-compose")
compose_file_args=("-f" "$SELECTED_COMPOSE_FILE")
if [ "$USE_GPU_FLAG" == "yes" ]; then
    compose_file_args+=("-f" "deployment/docker-compose.gpu.yml")
fi

echo "Stopping services for the selected configuration..."
"${docker_compose_cmd_array[@]}" "${compose_file_args[@]}" down --remove-orphans || true

# Set up production data directories if using docker-compose.prod.yml
if [[ "$SELECTED_COMPOSE_FILE" == *"docker-compose.prod.yml"* ]]; then
    echo ""
    echo "Setting up production data directories..."
    
    # Create all data directories
    mkdir -p "$DEPLOYMENT_DATA_DIR"/{app-uploads,app-logs,postgres-data,vespa-data,grafana-storage,loki-data,promtail-data,prometheus-data,ollama-data}
    
    # Create Vespa tmp directory
    mkdir -p "$DEPLOYMENT_DATA_DIR/vespa-data/tmp"
    
    echo "Setting directory permissions using Docker containers (no sudo required)..."
    
    # Set app permissions (UID 1000)
    docker run --rm -v "$(pwd)/$DEPLOYMENT_DATA_DIR/app-uploads:/data" busybox chown -R 1000:1000 /data 2>/dev/null || echo "Warning: Could not set app-uploads permissions"
    docker run --rm -v "$(pwd)/$DEPLOYMENT_DATA_DIR/app-logs:/data" busybox chown -R 1000:1000 /data 2>/dev/null || echo "Warning: Could not set app-logs permissions"
    
    # Set database permissions (UID 1000 for compatibility)  
    docker run --rm -v "$(pwd)/$DEPLOYMENT_DATA_DIR/postgres-data:/data" busybox chown -R 1000:1000 /data 2>/dev/null || echo "Warning: Could not set postgres permissions"
    
    # Set Vespa permissions (UID 1000)
    docker run --rm -v "$(pwd)/$DEPLOYMENT_DATA_DIR/vespa-data:/data" busybox chown -R 1000:1000 /data 2>/dev/null || echo "Warning: Could not set vespa permissions"
    
    # Set Grafana permissions (UID 1000, will be handled by DOCKER_UID env var)
    docker run --rm -v "$(pwd)/$DEPLOYMENT_DATA_DIR/grafana-storage:/data" busybox chown -R 1000:1000 /data 2>/dev/null || echo "Warning: Could not set grafana permissions"
    
    # Set monitoring service permissions with their specific UIDs
    docker run --rm -v "$(pwd)/$DEPLOYMENT_DATA_DIR/prometheus-data:/data" busybox sh -c 'mkdir -p /data && chown -R 65534:65534 /data' 2>/dev/null || echo "Warning: Could not set prometheus permissions"
    docker run --rm -v "$(pwd)/$DEPLOYMENT_DATA_DIR/loki-data:/data" busybox sh -c 'mkdir -p /data && chown -R 10001:10001 /data' 2>/dev/null || echo "Warning: Could not set loki permissions"  
    docker run --rm -v "$(pwd)/$DEPLOYMENT_DATA_DIR/promtail-data:/data" busybox sh -c 'mkdir -p /data && chown -R 10001:10001 /data' 2>/dev/null || echo "Warning: Could not set promtail permissions"
    
    # Set basic directory permissions
    chmod -R 755 "$DEPLOYMENT_DATA_DIR" 2>/dev/null || echo "Warning: Could not set directory permissions"
    
    echo "Production data directories setup complete."
    echo ""
fi

# Legacy directory setup for non-production compose files
if [[ "$SELECTED_COMPOSE_FILE" != *"docker-compose.prod.yml"* ]]; then
    # Check if Loki service is in the selected compose file
    if grep -q -E "^[[:space:]]*loki:" "$SELECTED_COMPOSE_FILE"; then
        echo "Setting up directory for Loki: $LOKI_DIR_RELATIVE"
        mkdir -p "$LOKI_DIR_RELATIVE" # Attempting without sudo
        # The following chown will likely fail without sudo and is critical for Docker permissions.
        # If you lack sudo, ensure $LOKI_DIR_RELATIVE is writable by UID $LOKI_UID from within Docker.
        # sudo chown "$LOKI_UID:$LOKI_GID" "$LOKI_DIR_RELATIVE"
        chmod 755 "$LOKI_DIR_RELATIVE" # Attempting without sudo
        echo "Loki directory setup complete (ran mkdir/chmod without sudo, chown skipped)."
    else
        echo "Loki service not found in $SELECTED_COMPOSE_FILE. Skipping Loki directory setup."
    fi
    
    # Check if Promtail service is in the selected compose file  
    if grep -q -E "^[[:space:]]*promtail:" "$SELECTED_COMPOSE_FILE"; then
        echo "Setting up directory for Promtail: deployment/promtail"
        mkdir -p "deployment/promtail" # Attempting without sudo
        chmod 755 "deployment/promtail" # Attempting without sudo
        echo "Promtail directory setup complete (ran mkdir/chmod without sudo, chown skipped)."
        echo "Note: Promtail requires Docker socket access. Ensure user is in docker group or run with appropriate permissions."
    else
        echo "Promtail service not found in $SELECTED_COMPOSE_FILE. Skipping Promtail directory setup."
    fi
fi

# Legacy directory setup for non-production compose files (continued)
if [[ "$SELECTED_COMPOSE_FILE" != *"docker-compose.prod.yml"* ]]; then
    # Check if Vespa service is in the selected compose file
    if grep -q -E "^[[:space:]]*vespa:" "$SELECTED_COMPOSE_FILE"; then
        echo "Setting up directories for Vespa..."
        # Vespa Data Directory
        echo "Setting up Vespa data directory: $VESPA_DATA_DIR_RELATIVE"
        mkdir -p "$VESPA_DATA_DIR_RELATIVE" # Attempting without sudo
        # The following chown will likely fail without sudo and is critical for Docker permissions.
        # If you lack sudo, ensure $VESPA_DATA_DIR_RELATIVE is writable by UID $VESPA_UID from within Docker.
        # sudo chown "$VESPA_UID:$VESPA_GID" "$VESPA_DATA_DIR_RELATIVE"
        chmod 755 "$VESPA_DATA_DIR_RELATIVE" # Attempting without sudo

        # Vespa Logs Directory - check if it's used in the selected file
        # Some configurations might not use a separate logs volume on host
        if grep -q "$VESPA_LOGS_DIR_RELATIVE" "$SELECTED_COMPOSE_FILE"; then
            echo "Setting up Vespa logs directory: $VESPA_LOGS_DIR_RELATIVE"
            mkdir -p "$VESPA_LOGS_DIR_RELATIVE" # Attempting without sudo
            # The following chown will likely fail without sudo and is critical for Docker permissions.
            # If you lack sudo, ensure $VESPA_LOGS_DIR_RELATIVE is writable by UID $VESPA_UID from within Docker.
            # sudo chown "$VESPA_UID:$VESPA_GID" "$VESPA_LOGS_DIR_RELATIVE"
            chmod 755 "$VESPA_LOGS_DIR_RELATIVE" # Attempting without sudo
        else
            echo "Vespa logs directory ($VESPA_LOGS_DIR_RELATIVE) not explicitly found in $SELECTED_COMPOSE_FILE volumes. Skipping specific setup for it."
        fi
        echo "Vespa directories setup complete (ran mkdir/chmod without sudo, chown skipped)."
    else
        echo "Vespa service not found in $SELECTED_COMPOSE_FILE. Skipping Vespa directory setup."
    fi

    # Check if Grafana service is in the selected compose file
    if grep -q -E "^[[:space:]]*grafana:" "$SELECTED_COMPOSE_FILE"; then
        echo "Setting up directory for Grafana: $GRAFANA_STORAGE_DIR_RELATIVE"
        mkdir -p "$GRAFANA_STORAGE_DIR_RELATIVE" # Attempting without sudo
        # The following chown will likely fail without sudo and is critical for Docker permissions.
        # If you lack sudo, ensure $GRAFANA_STORAGE_DIR_RELATIVE is writable by UID $GRAFANA_UID from within Docker.
        # sudo chown "$GRAFANA_UID:$GRAFANA_GID" "$GRAFANA_STORAGE_DIR_RELATIVE"
        chmod 755 "$GRAFANA_STORAGE_DIR_RELATIVE" # Attempting without sudo. Grafana might need 775 if it runs processes as different group members.
        echo "Grafana directory setup complete (ran mkdir/chmod without sudo, chown skipped)."
    else
        echo "Grafana service not found in $SELECTED_COMPOSE_FILE. Skipping Grafana directory setup."
    fi
fi

# Prometheus does not require host directory setup based on current configurations

echo ""
echo "Starting services for the selected configuration..."
"${docker_compose_cmd_array[@]}" "${compose_file_args[@]}" up -d

echo ""
echo "Setup complete. Services should be starting."

# Construct the command string for user display only
display_cmd_string="docker-compose"
for arg in "${compose_file_args[@]}"; do
    display_cmd_string="$display_cmd_string \"$arg\""
done
echo "You can check the status with: $display_cmd_string ps"
echo "And logs with: $display_cmd_string logs -f"

# Provide information about log monitoring if Promtail is included
if grep -q -E "^[[:space:]]*promtail:" "$SELECTED_COMPOSE_FILE"; then
    echo ""
    echo "=== Log Monitoring Setup ==="
    echo "Promtail is configured to collect logs from:"
    echo "  • Docker containers (via Docker socket)"
    echo "  • Application log files"
    echo ""
    echo "Access log monitoring at:"
    if grep -q -E "^[[:space:]]*grafana:" "$SELECTED_COMPOSE_FILE"; then
        echo "  • Grafana (Log Explorer): http://localhost:3002"
    fi
    if grep -q -E "^[[:space:]]*loki:" "$SELECTED_COMPOSE_FILE"; then
        echo "  • Loki API: http://localhost:3100"
    fi
    echo ""
    echo "To verify logs are being collected:"
    echo "  curl -s \"http://localhost:3100/loki/api/v1/query_range?query={job=~\\\".+\\\"}&start=\$(date -d '1 hour ago' +%s)000000000&end=\$(date +%s)000000000\""
    echo ""
    echo "Docker Group ID for Promtail: $DOCKER_GROUP_ID"
    echo "Environment variables set in: $ENV_FILE"
fi

exit 0
