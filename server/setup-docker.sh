#!/bin/bash
set -e

until docker exec xyne-db pg_isready -U xyne; do
    echo "Waiting for database connection..."
    sleep 2
  done
  echo "Database is ready!"

  sleep 15

  docker exec -it xyne-app bash -c "
    echo 'Inside xyne-app container...';
    echo 'Running initialization script...';
    ./init-script.sh --docker;
    echo 'Initialisation complete. Starting the app...';
  "
docker restart xyne-app