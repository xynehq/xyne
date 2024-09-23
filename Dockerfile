# Use the official Bun image
FROM oven/bun:1 AS base
WORKDIR /usr/src/app

# Install backend dependencies
COPY package.json bun.lockb ./
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
EXPOSE 3000/tcp

# Run the backend app
USER bun
ENTRYPOINT [ "bun", "run", "server.ts" ]
