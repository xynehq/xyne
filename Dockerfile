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
COPY --chown=bun:bun server/ /usr/src/app/server/
COPY --chown=bun:bun frontend/ /usr/src/app/frontend/

# Copy other necessary files
COPY --chown=bun:bun biome.json /usr/src/app/

# Make scripts executable
WORKDIR /usr/src/app/server
RUN chmod +x docker-init.sh 2>/dev/null || true

# Build the frontend
WORKDIR /usr/src/app/frontend
RUN bun run build

# Set the environment as production
ENV NODE_ENV=production

# Install required tools, canvas dependencies, and vespa CLI
USER root
RUN apt-get update && apt-get install -y \
    wget \
    curl \
    tar \
    libexpat1 \
    libexpat1-dev \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    libpixman-1-dev \
    libfontconfig1-dev \
    libfreetype6-dev \
    && wget https://github.com/vespa-engine/vespa/releases/download/v8.453.24/vespa-cli_8.453.24_linux_amd64.tar.gz \
    && tar -xzf vespa-cli_8.453.24_linux_amd64.tar.gz \
    && mv vespa-cli_8.453.24_linux_amd64/bin/vespa /usr/local/bin/ \
    && rm -rf vespa-cli_8.453.24_linux_amd64 vespa-cli_8.453.24_linux_amd64.tar.gz \
    && apt-get clean && rm -rf /var/lib/apt/lists/*


# Copy data restoration script and make it executable
#COPY deployment/restore-data.sh /usr/src/app/deployment/restore-data.sh
#RUN chmod +x /usr/src/app/deployment/restore-data.sh

# Copy sample data archive if it exists (conditional copy during build)
#COPY deployment/sample-data.tar.gz* /usr/src/app/deployment/

# Note: Application ports are exposed below

WORKDIR /usr/src/app/server

# Create runtime directories and set ownership for bun user
RUN mkdir -p downloads vespa-data vespa-logs uploads migrations && \
    chown bun:bun downloads vespa-data vespa-logs uploads migrations

# Copy and setup startup script
COPY --chown=bun:bun start.sh /usr/src/app/start.sh
RUN chmod +x /usr/src/app/start.sh

USER bun

# Expose application ports
EXPOSE 3000
EXPOSE 3001

CMD ["/usr/src/app/start.sh"]

