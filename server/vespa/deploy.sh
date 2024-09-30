#!/bin/sh
set -e

vespa deploy
docker restart vespa
# vespa destroy
vespa status --wait 55