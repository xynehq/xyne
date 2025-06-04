#!/bin/bash
set -e

mkdir -p ./vespa-data ./vespa-logs
sudo chown -R 1000:1000 ./vespa-data ./vespa-logs
sudo chmod -R 755 ./vespa-data ./vespa-logs
echo "Successfully set permissions for vespa in docker...."
