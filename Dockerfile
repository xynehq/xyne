# Use the official Bun image
FROM oven/bun:1 AS base

WORKDIR /usr/src/app

# Copy all files into the container
COPY . .

# Switch to server directory and install backend dependencies
WORKDIR /usr/src/app/server
RUN bun install
RUN chmod +x docker-init.sh 


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

## A delay of 20 seconds to wait for the other containers to start running and the migrate changes and deploy schema changes
CMD ["sh", "-c", "sleep 20 && if [ -f /usr/src/app/server/.env ]; then . /usr/src/app/server/.env; fi && bun run generate && bun run migrate && cd /usr/src/app/server/vespa && EMBEDDING_MODEL=$EMBEDDING_MODEL ./deploy-docker.sh && cd /usr/src/app/server/ && bun run server.ts"]

