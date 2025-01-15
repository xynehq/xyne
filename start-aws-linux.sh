#!/bin/bash
set -e

if [[ "$1" == "--prod" ]]; then
  echo "Running in production mode....."
# Install Bun (JavaScript runtime)
echo "Installing Bun..."
cd ~
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
bun --version

# Install Docker and start the Docker service
echo "Installing Docker..."
sudo yum install -y docker
sudo service docker start

# Add the current user to the Docker group (so you don't need to use `sudo` with Docker commands)
sudo usermod -a -G docker $USER

# Install Docker Compose
echo "Installing Docker Compose..."
curl -s https://api.github.com/repos/docker/compose/releases/latest | grep browser_download_url  | grep docker-compose-linux-x86_64 | cut -d '"' -f 4 | wget -qi -
chmod +x docker-compose-linux-x86_64
sudo mv docker-compose-linux-x86_64 /usr/local/bin/docker-compose
docker-compose --version

# Install Vespa CLI (you can replace the version with the latest)
echo "Installing Vespa CLI..."
wget https://github.com/vespa-engine/vespa/releases/download/v8.453.24/vespa-cli_8.453.24_linux_amd64.tar.gz
tar -xzf vespa-cli_8.453.24_linux_amd64.tar.gz
sudo mv vespa-cli_8.453.24_linux_amd64/bin/vespa /usr/local/bin/
vespa version

cd xyne
# Give execute permissions to the init-script.sh inside the server folder
echo "Setting execute permissions for init-script.sh..."
chmod +x ./server/init-script.sh

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

# Run init-script.sh to initialize the services
echo "Running init-script.sh..."
cd ./server
./init-script.sh

# You can add more logic here to monitor or wait for other processes, if needed
echo "Initialization complete!"

# Finally, run the server
echo "Starting the app..."
sudo NODE_ENV=production $(which  bun) run server.ts

elif [[ "$1" == "--docker" ]]; then
  echo "Running using docker images .... "
    # Start the Docker Compose services in the background
  echo "Starting Docker Compose services..."
  chmod +x ./server/init-vespa.sh 

  ./server/init-vespa.sh

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
    ./docker-init.sh;
    echo 'Initialisation complete. Starting the app...';
  "
  docker restart xyne-app
fi

echo "Started xyne-app...."