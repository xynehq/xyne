#!/bin/bash

# PostgreSQL Database Backup Script for Xyne
# This script creates a full backup of the PostgreSQL database

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
DB_NAME="xyne"
DB_USER="xyne"
DB_PASSWORD="xyne"
DB_HOST="localhost"
DB_PORT="5432"

# Docker container name (if using Docker)
DOCKER_CONTAINER="xyne-db"

# Create backup directory if it doesn't exist
mkdir -p "$BACKUP_DIR"

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

# Function to check if Docker container is running
check_docker_container() {
    if docker ps --format "table {{.Names}}" | grep -q "^${DOCKER_CONTAINER}$"; then
        return 0
    else
        return 1
    fi
}

# Function to check if PostgreSQL is accessible locally
check_local_postgres() {
    if command -v pg_isready &> /dev/null; then
        if pg_isready -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" &> /dev/null; then
            return 0
        fi
    fi
    return 1
}

# Function to create backup using Docker
backup_via_docker() {
    print_info "Creating backup using Docker container: $DOCKER_CONTAINER"
    
    local timestamp=$(date +"%Y%m%d_%H%M%S")
    local backup_file="xyne_backup_${timestamp}.sql"
    local backup_path="${BACKUP_DIR}/${backup_file}"
    
    print_info "Backup file: $backup_file"
    print_info "Full path: $backup_path"
    
    # Create the backup
    if docker exec "$DOCKER_CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" --verbose --no-owner --no-privileges > "$backup_path"; then
        # Compress the backup
        print_info "Compressing backup..."
        if gzip "$backup_path"; then
            local compressed_file="${backup_file}.gz"
            local compressed_path="${BACKUP_DIR}/${compressed_file}"
            print_success "Backup completed successfully!"
            print_success "Compressed backup saved to: $compressed_path"
            print_info "Backup size: $(du -h "$compressed_path" | cut -f1)"
            
            # Create a symlink to the latest backup
            ln -sf "$compressed_file" "${BACKUP_DIR}/latest_backup.sql.gz"
            print_info "Latest backup symlink updated"
            
            return 0
        else
            print_error "Failed to compress backup"
            return 1
        fi
    else
        print_error "Failed to create backup via Docker"
        return 1
    fi
}

# Function to create backup using local PostgreSQL
backup_via_local() {
    print_info "Creating backup using local PostgreSQL installation"
    
    local timestamp=$(date +"%Y%m%d_%H%M%S")
    local backup_file="xyne_backup_${timestamp}.sql"
    local backup_path="${BACKUP_DIR}/${backup_file}"
    
    print_info "Backup file: $backup_file"
    print_info "Full path: $backup_path"
    
    # Set password for pg_dump
    export PGPASSWORD="$DB_PASSWORD"
    
    # Create the backup
    if pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" --verbose --no-owner --no-privileges > "$backup_path"; then
        # Compress the backup
        print_info "Compressing backup..."
        if gzip "$backup_path"; then
            local compressed_file="${backup_file}.gz"
            local compressed_path="${BACKUP_DIR}/${compressed_file}"
            print_success "Backup completed successfully!"
            print_success "Compressed backup saved to: $compressed_path"
            print_info "Backup size: $(du -h "$compressed_path" | cut -f1)"
            
            # Create a symlink to the latest backup
            ln -sf "$compressed_file" "${BACKUP_DIR}/latest_backup.sql.gz"
            print_info "Latest backup symlink updated"
            
            return 0
        else
            print_error "Failed to compress backup"
            return 1
        fi
    else
        print_error "Failed to create backup via local PostgreSQL"
        return 1
    fi
}

# Function to list existing backups
list_backups() {
    print_info "Existing backups in $BACKUP_DIR:"
    if ls -la "$BACKUP_DIR"/*.sql.gz 2>/dev/null | head -10; then
        local backup_count=$(ls -1 "$BACKUP_DIR"/*.sql.gz 2>/dev/null | wc -l)
        if [ "$backup_count" -gt 10 ]; then
            print_info "... and $((backup_count - 10)) more backups"
        fi
    else
        print_warning "No existing backups found"
    fi
}

# Function to cleanup old backups (keep last 10)
cleanup_old_backups() {
    print_info "Cleaning up old backups (keeping last 10)..."
    local backup_files=($(ls -t "$BACKUP_DIR"/xyne_backup_*.sql.gz 2>/dev/null || true))
    
    if [ ${#backup_files[@]} -gt 10 ]; then
        print_info "Found ${#backup_files[@]} backups, removing old ones..."
        for ((i=10; i<${#backup_files[@]}; i++)); do
            print_info "Removing old backup: $(basename "${backup_files[i]}")"
            rm -f "${backup_files[i]}"
        done
    else
        print_info "No cleanup needed (${#backup_files[@]} backups found)"
    fi
}

# Main execution
main() {
    print_info "Starting PostgreSQL database backup for Xyne"
    print_info "Timestamp: $(date)"
    
    # Check if --list flag is provided
    if [[ "${1:-}" == "--list" ]]; then
        list_backups
        exit 0
    fi
    
    # Check if --cleanup flag is provided
    if [[ "${1:-}" == "--cleanup" ]]; then
        cleanup_old_backups
        exit 0
    fi
    
    # Show current backup directory info
    print_info "Backup directory: $BACKUP_DIR"
    
    # Try Docker first, then local PostgreSQL
    if check_docker_container; then
        backup_via_docker
    elif check_local_postgres; then
        backup_via_local
    else
        print_error "Cannot connect to PostgreSQL database!"
        print_error "Please ensure either:"
        print_error "1. Docker container '$DOCKER_CONTAINER' is running, OR"
        print_error "2. PostgreSQL is running locally on $DB_HOST:$DB_PORT"
        exit 1
    fi
    
    # List current backups
    echo ""
    list_backups
    
    # Cleanup old backups
    echo ""
    cleanup_old_backups
    
    print_success "Backup process completed!"
}

# Show usage information
show_usage() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "OPTIONS:"
    echo "  --list     List existing backups"
    echo "  --cleanup  Clean up old backups (keep last 10)"
    echo "  --help     Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0                # Create a new backup"
    echo "  $0 --list         # List all existing backups"
    echo "  $0 --cleanup      # Remove old backups"
}

# Handle command line arguments
if [[ "${1:-}" == "--help" ]]; then
    show_usage
    exit 0
fi

# Run main function
main "$@"
