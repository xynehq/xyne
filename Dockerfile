# Use the official Bun image
FROM oven/bun:1 AS base
WORKDIR /usr/src/app

# Install backend dependencies
WORKDIR /usr/src/app/server
COPY server/package.json server/bun.lockb ./
RUN bun install --frozen-lockfile

# Install frontend dependencies
WORKDIR /usr/src/app/frontend
COPY frontend/package.json frontend/bun.lockb ./
RUN bun install --frozen-lockfile

# Copy the entire project (excluding files listed in .dockerignore)
WORKDIR /usr/src/app
COPY . .

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
