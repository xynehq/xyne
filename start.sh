#!/bin/bash
set -e

if [[ "$1" == "--prod" ]]; then
  echo "Running in production mode....."
  # Give execute permissions to the init-script.sh inside the server folder
  echo "Setting execute permissions for init-script.sh..."
  chmod +x ./server/init-script.sh 
  # ./server/init-vespa.sh ./server/vespa/deploy.sh

  # Start the Docker Compose services in the background
  echo "Starting Docker Compose services..."
  docker-compose -f deployment/docker-compose.prod.yml up -d

  # Wait for the containers to be fully initialized (You can customize the wait time or logic)
  echo "Waiting for services to be ready..."
  # Wait for the xyne-db container to be ready (PostgreSQL service)
  until docker exec xyne-db pg_isready -U xyne; do
    echo "Waiting for database connection..."
    sleep 2
  done
  echo "Database is ready!"

  echo "Running init-script.sh..."
  ./init-script

  # You can add more logic here to monitor or wait for other processes, if needed
  echo "Initialization complete!"

  sudo NODE_ENV=production $(which bun) run ./server/server.ts

elif [[ "$1" == "--docker" ]]; then
  echo "Running using docker images .... "
    # Start the Docker Compose services in the background
  echo "Starting Docker Compose services..."
  docker-compose -f deployment/docker-compose.yml up --build -d
    # Wait for the containers to be fully initialized (You can customize the wait time or logic)
  echo "Waiting for services to be ready..."
  # Wait for the xyne-db container to be ready (PostgreSQL service)
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
    bun run server.ts;
  "
fi
