#!/bin/bash

# PostgreSQL Database Restore Script for Xyne
# This script restores the PostgreSQL database from a backup file

set -euo pipefail

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="${SCRIPT_DIR}/db-backups"

# Function to print colored output
print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Load environment variables from .env file
ENV_FILE="${SCRIPT_DIR}/../.env"
if [ -f "$ENV_FILE" ]; then
    print_info "Loading database configuration from $ENV_FILE"
    # Source the .env file to properly handle quoted values
    set -a  # Automatically export all variables
    source "$ENV_FILE"
    set +a  # Stop automatically exporting
    print_info "Found database variables in .env file"
else
    print_error ".env file not found at $ENV_FILE"
    exit 1
fi

# Fallback to default values if not set in .env
DB_NAME="${DB_NAME:-xyne}"
DB_USER="${DB_USER:-xyne}"
DB_PASSWORD="${DB_PASSWORD:-xyne}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"


# Docker container name (if using Docker)
DOCKER_CONTAINER="${DATABASE_HOST:-xyne-db}"

# Cache Docker availability to avoid repeated checks
DOCKER_AVAILABLE=""

# Create backup directory if it doesn't exist
mkdir -p "$BACKUP_DIR"

# Function to check if Docker container is running
check_docker_container() {
    # Use cached result if available
    if [ "$DOCKER_AVAILABLE" = "yes" ]; then
        return 0
    elif [ "$DOCKER_AVAILABLE" = "no" ]; then
        return 1
    fi
    
    print_info "Checking if Docker container '$DOCKER_CONTAINER' is running..."
    
    # Use a more reliable Docker check
    if docker ps --filter "name=^${DOCKER_CONTAINER}$" --filter "status=running" --format "{{.Names}}" | grep -q "^${DOCKER_CONTAINER}$"; then
        print_info "Docker container '$DOCKER_CONTAINER' found and running"
        DOCKER_AVAILABLE="yes"
        return 0
    else
        print_warning "Docker container '$DOCKER_CONTAINER' not found or not running"
        DOCKER_AVAILABLE="no"
        return 1
    fi
}

# Function to check if PostgreSQL is accessible locally
check_local_postgres() {
    print_info "Checking if local PostgreSQL is accessible..."
    if command -v pg_isready &> /dev/null; then
        if pg_isready -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" &> /dev/null; then
            print_info "Local PostgreSQL is accessible"
            return 0
        else
            print_warning "Local PostgreSQL is not accessible"
            return 1
        fi
    else
        print_warning "pg_isready command not found"
        return 1
    fi
}

# Function to list available backups
list_backups() {
    print_info "Available backups in $BACKUP_DIR:"
    if ls -la "$BACKUP_DIR"/*.sql.gz 2>/dev/null; then
        return 0
    else
        print_warning "No backup files found in $BACKUP_DIR"
        return 1
    fi
}

# Function to validate backup file
validate_backup_file() {
    local backup_file="$1"
    
    if [[ ! -f "$backup_file" ]]; then
        print_error "Backup file does not exist: $backup_file"
        return 1
    fi
    
    if [[ ! "$backup_file" =~ \.sql\.gz$ ]] && [[ ! "$backup_file" =~ \.sql$ ]]; then
        print_error "Invalid backup file format. Expected .sql or .sql.gz file"
        return 1
    fi
    
    # Check if file is readable
    if [[ ! -r "$backup_file" ]]; then
        print_error "Cannot read backup file: $backup_file"
        return 1
    fi
    
    # Check if compressed file is valid
    if [[ "$backup_file" =~ \.gz$ ]]; then
        if ! gzip -t "$backup_file" 2>/dev/null; then
            print_error "Backup file appears to be corrupted: $backup_file"
            return 1
        fi
    fi
    
    return 0
}

# Function to create a safety backup before restore
create_safety_backup() {
    print_warning "Creating safety backup before restore..."
    
    local timestamp=$(date +"%Y%m%d_%H%M%S")
    local safety_backup="safety_backup_before_restore_${timestamp}.sql"
    local safety_path="${BACKUP_DIR}/${safety_backup}"
    
    if check_docker_container; then
        if docker exec "$DOCKER_CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" --no-owner --no-privileges > "$safety_path"; then
            gzip "$safety_path"
            print_success "Safety backup created: ${safety_backup}.gz"
            return 0
        else
            print_error "Failed to create safety backup via Docker"
            return 1
        fi
    elif check_local_postgres; then
        export PGPASSWORD="$DB_PASSWORD"
        if pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" --no-owner --no-privileges > "$safety_path"; then
            gzip "$safety_path"
            print_success "Safety backup created: ${safety_backup}.gz"
            return 0
        else
            print_error "Failed to create safety backup via local PostgreSQL"
            return 1
        fi
    else
        print_error "Cannot create safety backup - database not accessible"
        return 1
    fi
}

# Function to get database info
get_database_info() {
    print_info "Current database information:"
    
    if check_docker_container; then
        docker exec "$DOCKER_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c "
            SELECT 
                current_database() as database_name,
                current_user as current_user,
                version() as version;
            SELECT COUNT(*) as table_count FROM information_schema.tables WHERE table_schema = 'public';
        " 2>/dev/null || print_warning "Could not retrieve database info"
    elif check_local_postgres; then
        export PGPASSWORD="$DB_PASSWORD"
        psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "
            SELECT 
                current_database() as database_name,
                current_user as current_user,
                version() as version;
            SELECT COUNT(*) as table_count FROM information_schema.tables WHERE table_schema = 'public';
        " 2>/dev/null || print_warning "Could not retrieve database info"
    fi
}

# Function to restore database via Docker
restore_via_docker() {
    local backup_file="$1"
    
    print_info "Restoring database using Docker container: $DOCKER_CONTAINER"
    print_info "Backup file: $(basename "$backup_file")"
    
    # Drop all connections to the database
    print_info "Terminating existing connections to database..."
    docker exec "$DOCKER_CONTAINER" psql -U "$DB_USER" -d postgres -c "
        SELECT pg_terminate_backend(pid) 
        FROM pg_stat_activity 
        WHERE datname = '$DB_NAME' AND pid <> pg_backend_pid();
    " 2>/dev/null || print_warning "Could not terminate connections"
    
    # Drop and recreate database
    print_warning "Dropping and recreating database '$DB_NAME'..."
    if docker exec "$DOCKER_CONTAINER" psql -U "$DB_USER" -d postgres -c "DROP DATABASE IF EXISTS $DB_NAME;" && \
       docker exec "$DOCKER_CONTAINER" psql -U "$DB_USER" -d postgres -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;"; then
        print_success "Database recreated successfully"
    else
        print_error "Failed to recreate database"
        return 1
    fi
    
    # Restore from backup
    print_info "Restoring data from backup..."
    if [[ "$backup_file" =~ \.gz$ ]]; then
        if gunzip -c "$backup_file" | docker exec -i "$DOCKER_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME"; then
            print_success "Database restored successfully!"
            return 0
        else
            print_error "Failed to restore database from compressed backup"
            return 1
        fi
    else
        if cat "$backup_file" | docker exec -i "$DOCKER_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME"; then
            print_success "Database restored successfully!"
            return 0
        else
            print_error "Failed to restore database from backup"
            return 1
        fi
    fi
}

# Function to restore database via local PostgreSQL
restore_via_local() {
    local backup_file="$1"
    
    print_info "Restoring database using local PostgreSQL installation"
    print_info "Backup file: $(basename "$backup_file")"
    
    export PGPASSWORD="$DB_PASSWORD"
    
    # Drop all connections to the database
    print_info "Terminating existing connections to database..."
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -c "
        SELECT pg_terminate_backend(pid) 
        FROM pg_stat_activity 
        WHERE datname = '$DB_NAME' AND pid <> pg_backend_pid();
    " 2>/dev/null || print_warning "Could not terminate connections"
    
    # Drop and recreate database
    print_warning "Dropping and recreating database '$DB_NAME'..."
    if psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -c "DROP DATABASE IF EXISTS $DB_NAME;" && \
       psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;"; then
        print_success "Database recreated successfully"
    else
        print_error "Failed to recreate database"
        return 1
    fi
    
    # Restore from backup
    print_info "Restoring data from backup..."
    if [[ "$backup_file" =~ \.gz$ ]]; then
        if gunzip -c "$backup_file" | psql -v ON_ERROR_STOP=1 -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME"; then
            print_success "Database restored successfully!"
            return 0
        else
            print_error "Failed to restore database from compressed backup"
            return 1
        fi
    else
        if psql -v ON_ERROR_STOP=1 -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" < "$backup_file"; then
            print_success "Database restored successfully!"
            return 0
        else
            print_error "Failed to restore database from backup"
            return 1
        fi
    fi
}

# Function to prompt for confirmation
confirm_restore() {
    local backup_file="$1"
    
    print_warning "⚠️  WARNING: This will completely replace your current database!"
    print_info "Backup file: $(basename "$backup_file")"
    print_info "Backup size: $(du -h "$backup_file" | cut -f1)"
    print_info "Backup date: $(stat -f "%Sm" -t "%Y-%m-%d %H:%M:%S" "$backup_file" 2>/dev/null || stat -c "%y" "$backup_file" 2>/dev/null || echo "Unknown")"
    
    echo ""
    read -p "Are you sure you want to proceed with the restore? (yes/no): " confirmation
    
    case "$confirmation" in
        [Yy][Ee][Ss])
            return 0
            ;;
        *)
            print_info "Restore cancelled by user"
            return 1
            ;;
    esac
}

# Main execution
main() {
    local backup_file=""
    local skip_confirmation=false
    local skip_safety_backup=false
    
    # Parse command line arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            --file)
                backup_file="$2"
                shift 2
                ;;
            --latest)
                backup_file="${BACKUP_DIR}/latest_backup.sql.gz"
                shift
                ;;
            --yes)
                skip_confirmation=true
                shift
                ;;
            --no-safety-backup)
                skip_safety_backup=true
                shift
                ;;
            --list)
                list_backups
                exit 0
                ;;
            --help)
                show_usage
                exit 0
                ;;
            *)
                print_error "Unknown option: $1"
                show_usage
                exit 1
                ;;
        esac
    done
    
    print_info "Starting PostgreSQL database restore for Xyne"
    print_info "Timestamp: $(date)"
    
    # If no backup file specified, list available backups and exit
    if [[ -z "$backup_file" ]]; then
        print_error "No backup file specified"
        echo ""
        if list_backups; then
            echo ""
            print_info "Use --file <backup_file> to specify a backup, or --latest to use the most recent backup"
        fi
        show_usage
        exit 1
    fi
    
    # If --latest is used but symlink doesn't exist, find the most recent backup
    if [[ "$backup_file" == "${BACKUP_DIR}/latest_backup.sql.gz" ]] && [[ ! -f "$backup_file" ]]; then
        print_info "Latest backup symlink not found, searching for most recent backup..."
        local latest_backup=$(ls -t "$BACKUP_DIR"/xyne_backup_*.sql.gz 2>/dev/null | head -1 || true)
        if [[ -n "$latest_backup" ]]; then
            backup_file="$latest_backup"
            print_info "Using most recent backup: $(basename "$backup_file")"
        else
            print_error "No backup files found"
            exit 1
        fi
    fi
    
    # Validate backup file
    if ! validate_backup_file "$backup_file"; then
        exit 1
    fi
    
    # Check database connectivity
    if ! check_docker_container && ! check_local_postgres; then
        print_error "Cannot connect to PostgreSQL database!"
        print_error "Please ensure either:"
        print_error "1. Docker container '$DOCKER_CONTAINER' is running, OR"
        print_error "2. PostgreSQL is running locally on $DB_HOST:$DB_PORT"
        exit 1
    fi
    
    # Show current database info
    echo ""
    get_database_info
    echo ""
    
    # Confirm restore operation
    if [[ "$skip_confirmation" == false ]]; then
        if ! confirm_restore "$backup_file"; then
            exit 1
        fi
    fi
    
    # Create safety backup unless skipped
    if [[ "$skip_safety_backup" == false ]]; then
        echo ""
        if ! create_safety_backup; then
            print_error "Failed to create safety backup. Aborting restore."
            print_info "Use --no-safety-backup to skip safety backup creation"
            exit 1
        fi
        echo ""
    fi
    
    # Perform restore
    print_info "Starting database restore..."
    if check_docker_container; then
        restore_via_docker "$backup_file"
    else
        restore_via_local "$backup_file"
    fi
    
    # Show final database info
    echo ""
    print_info "Restore completed. Final database information:"
    get_database_info
    
    print_success "Database restore process completed successfully!"
    print_info "You may need to restart your application to pick up the restored data"
}

# Show usage information
show_usage() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "OPTIONS:"
    echo "  --file <backup_file>    Restore from specific backup file"
    echo "  --latest                Restore from the latest backup"
    echo "  --list                  List available backup files"
    echo "  --yes                   Skip confirmation prompt"
    echo "  --no-safety-backup      Skip creating safety backup before restore"
    echo "  --help                  Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0 --list                           # List all available backups"
    echo "  $0 --latest                         # Restore from latest backup"
    echo "  $0 --file backup.sql.gz             # Restore from specific backup"
    echo "  $0 --latest --yes                   # Restore latest backup without confirmation"
    echo "  $0 --file backup.sql.gz --no-safety-backup  # Skip safety backup"
    echo ""
    echo "IMPORTANT:"
    echo "  - This script will completely replace your current database"
    echo "  - A safety backup is created automatically before restore (unless --no-safety-backup is used)"
    echo "  - All existing data will be lost and replaced with backup data"
}

# Run main function
main "$@"