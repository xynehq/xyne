#!/bin/bash

# =============================================================================
# Use Existing Data Script
# =============================================================================
# This script updates the portable deployment to use existing xyne-data 
# directory from the parent deployment folder instead of creating new data.
# Run this ONLY on the production server where you want to reuse existing data.
# =============================================================================

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}🔄 Configuring Portable Deployment to Use Existing Data${NC}"
echo "==========================================================="

# Check if we're in the portable directory
if [ ! -f "docker-compose.app.yml" ] || [ ! -f "deploy.sh" ]; then
    echo -e "${RED}❌ Error: This script must be run from the deployment/portable/ directory${NC}"
    exit 1
fi

# Check if parent xyne-data directory exists
if [ ! -d "../xyne-data" ]; then
    echo -e "${RED}❌ Error: ../xyne-data directory not found!${NC}"
    echo "This script expects an existing xyne-data directory in the parent deployment/ folder."
    exit 1
fi

echo -e "${YELLOW}📁 Found existing data directory: ../xyne-data${NC}"

# Function to update file
update_file() {
    local file="$1"
    local description="$2"
    
    if [ ! -f "$file" ]; then
        echo -e "${YELLOW}⚠️  File not found: $file (skipping)${NC}"
        return
    fi
    
    echo -e "${YELLOW}🔧 Updating $description...${NC}"
    
    # Create backup
    cp "$file" "$file.backup"
    
    # Replace ./data/ with ../xyne-data/ in volume mounts
    sed -i.tmp 's|^\( *- \)\./data/|\1../xyne-data/|g' "$file"
    
    # Replace "$(pwd)/data/ with "$(pwd)/../xyne-data/ in deploy.sh
    if [[ "$file" == "deploy.sh" ]]; then
        sed -i.tmp 's|"$(pwd)/data/|"$(pwd)/../xyne-data/|g' "$file"
        sed -i.tmp 's|mkdir -p \./data/|mkdir -p ../xyne-data/|g' "$file"
        sed -i.tmp 's|chmod -f 755 \./data|chmod -f 755 ../xyne-data|g' "$file"
    fi
    
    # Remove temporary file
    rm -f "$file.tmp"
    
    echo -e "${GREEN}✅ Updated $description${NC}"
}

# Update all compose files
update_file "docker-compose.app.yml" "Application compose file"
update_file "docker-compose.infrastructure.yml" "Infrastructure compose file (GPU)"
update_file "docker-compose.infrastructure-cpu.yml" "Infrastructure compose file (CPU)"
update_file "deploy.sh" "Deployment script"

echo ""
echo -e "${GREEN}🎉 Configuration completed successfully!${NC}"
echo ""
echo -e "${BLUE}📋 What was changed:${NC}"
echo "  • All volume mounts now point to ../xyne-data/ instead of ./data/"
echo "  • deploy.sh script updated to use existing data directory"
echo "  • Backup files created (.backup extension)"
echo ""
echo -e "${BLUE}📋 Next steps:${NC}"
echo "  1. Run: ./deploy.sh start"
echo "  2. Your existing data will be preserved and used"
echo ""
echo -e "${YELLOW}💡 To revert changes:${NC}"
echo "  • Restore from backup files: mv file.backup file"
echo "  • Or re-run git checkout to restore original files"

# Verify the changes
echo ""
echo -e "${BLUE}🔍 Verification - Data directory references:${NC}"
grep -n "xyne-data" docker-compose*.yml deploy.sh | head -5 || true
echo ""
echo -e "${GREEN}✅ Script completed. You can now run ./deploy.sh start to use existing data.${NC}"