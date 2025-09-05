#!/bin/bash
set -e

echo "Setting up permissions for vespa in docker...."
mkdir -p ./vespa-data ./vespa-logs
sudo chown -R 1000:1000 ./vespa-data ./vespa-logs
sudo chmod -R 755 ./vespa-data ./vespa-logs
echo "Successfully set permissions for vespa in docker...."

