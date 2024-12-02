# Use the official Bun image
FROM oven/bun:1 AS base
# Set working directory
WORKDIR /usr/src/app

# Copy your Bun app files
COPY . .

# Install dependencies for Bun server
WORKDIR /usr/src/app/server
RUN bun install

# Install dependencies for Bun client
WORKDIR /usr/src/app/frontend
RUN bun install
RUN bun run build

# [optional] tests & build for both backend and frontend
ENV NODE_ENV=production
# RUN bun test
# RUN bun run build

# Expose the application port
EXPOSE 80/tcp

# Run the backend app
# Set the working directory to the server folder
WORKDIR /usr/src/app/server
USER bun
ENTRYPOINT [ "bun", "run", "server.ts" ]