# Use the official Bun image
FROM oven/bun:1 AS base

WORKDIR /usr/src/app

# Copy all files into the container
COPY . .

# Switch to server directory and install backend dependencies
WORKDIR /usr/src/app/server
RUN bun install
RUN chmod +x init-script.sh 

# Install dependencies and build the frontend
WORKDIR /usr/src/app/frontend
RUN bun install
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


# Set ownership for bun user
RUN chown -R bun:bun /usr/src/app

# Expose the application port
EXPOSE 80/tcp

WORKDIR /usr/src/app/server

RUN mkdir -p downloads

USER bun

ENTRYPOINT [ "bun", "run", "server.ts" ]
