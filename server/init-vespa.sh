#!/bin/bash
set -e

mkdir -p ./vespa-data ./vespa-logs
sudo chown -R 1000:1000 ./server/vespa-data ./server/vespa-logs
