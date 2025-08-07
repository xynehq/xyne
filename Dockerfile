# Use the official Bun image
FROM oven/bun:1 AS base

WORKDIR /usr/src/app

# Copy package files first for better layer caching
COPY server/package.json server/bun.lock* /usr/src/app/server/
COPY frontend/package.json frontend/bun.lockb /usr/src/app/frontend/

# Switch to server directory and install backend dependencies
WORKDIR /usr/src/app/server
RUN bun install

# Install frontend dependencies
WORKDIR /usr/src/app/frontend
RUN bun install

# Copy server source code and configuration
WORKDIR /usr/src/app
COPY server/ /usr/src/app/server/
COPY frontend/ /usr/src/app/frontend/
COPY shared/ /usr/src/app/shared/

# Copy other necessary files
COPY biome.json /usr/src/app/
COPY .env* /usr/src/app/server/

# Make scripts executable
WORKDIR /usr/src/app/server
RUN chmod +x docker-init.sh 2>/dev/null || true

# Build the frontend
WORKDIR /usr/src/app/frontend
RUN bun run build

# Set the environment as production
ENV NODE_ENV=production

# Install required tools and vespa CLI
USER root
RUN apt-get update && apt-get install -y \
    wget \
    curl \
    tar \
    && wget https://github.com/vespa-engine/vespa/releases/download/v8.453.24/vespa-cli_8.453.24_linux_amd64.tar.gz \
    && tar -xzf vespa-cli_8.453.24_linux_amd64.tar.gz \
    && mv vespa-cli_8.453.24_linux_amd64/bin/vespa /usr/local/bin/ \
    && rm -rf vespa-cli_8.453.24_linux_amd64 vespa-cli_8.453.24_linux_amd64.tar.gz \
    && apt-get clean && rm -rf /var/lib/apt/lists/*


# Copy data restoration script and make it executable
COPY deployment/restore-data.sh /usr/src/app/deployment/restore-data.sh
RUN chmod +x /usr/src/app/deployment/restore-data.sh

# Copy sample data archive if it exists (conditional copy during build)
COPY deployment/sample-data.tar.gz* /usr/src/app/deployment/

# Set ownership for bun user
RUN chown -R bun:bun /usr/src/app

# Expose the application port
EXPOSE 80/tcp

WORKDIR /usr/src/app/server

RUN mkdir -p downloads vespa-data vespa-logs uploads

# Copy and setup startup script
COPY start.sh /usr/src/app/start.sh
RUN chmod +x /usr/src/app/start.sh

USER bun

# Expose port 3000 (will be mapped to 80 in docker-compose)
EXPOSE 3000

CMD ["/usr/src/app/start.sh"]

