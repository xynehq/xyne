# Use the official Bun image
FROM oven/bun:1 AS base
WORKDIR /usr/src/app

# Install backend dependencies
COPY . .

WORKDIR /usr/src/app/server
RUN bun install

# Install dependencies for frontend
WORKDIR /usr/src/app/frontend
RUN bun install
RUN bun run build

# Set the environment as production
ENV NODE_ENV=production


# Expose the application port
EXPOSE 80/tcp

# Run the backend app
# Set the working directory to the server folder
WORKDIR /usr/src/app/server

RUN mkdir -p downloads

USER bun
ENTRYPOINT [ "bun", "run", "server.ts" ]