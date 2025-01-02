#!/bin/bash
set -e

mkdir -p ./vespa-data ./vespa-logs
if [ "$1" == "--docker" ]; then
    chown -R 1000:1000 ./vespa-data ./vespa-logs
    chmod -R 755 ./vespa-data ./vespa-logs
    echo "Successfully set permissions for vespa in docker...."
else
    sudo chown -R 1000:1000 ./vespa-data ./vespa-logs
    sudo chmod -R 755 ./vespa-data ./vespa-logs
    echo "Successfully set permissions for vespa...."
fi
