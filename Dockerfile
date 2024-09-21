# # use the official Bun image
# # see all versions at https://hub.docker.com/r/oven/bun/tags
# FROM oven/bun:1 AS base
# WORKDIR /usr/src/app

# # install dependencies into temp directory
# # this will cache them and speed up future builds
# FROM base AS install
# RUN mkdir -p /temp/dev
# COPY package.json bun.lockb /temp/dev/
# RUN cd /temp/dev && bun install --frozen-lockfile

# # install with --production (exclude devDependencies)
# RUN mkdir -p /temp/prod
# COPY package.json bun.lockb /temp/prod/
# RUN cd /temp/prod && bun install --frozen-lockfile --production

# # copy node_modules from temp directory
# # then copy all (non-ignored) project files into the image
# FROM base AS prerelease
# COPY --from=install /temp/dev/node_modules node_modules
# COPY . .

# # [optional] tests & build
# ENV NODE_ENV=production
# # RUN bun test
# # RUN bun run build

# # copy production dependencies and source code into final image
# FROM base AS release
# COPY --from=install /temp/prod/node_modules node_modules
# COPY --from=prerelease /usr/src/app/index.ts .
# COPY --from=prerelease /usr/src/app/package.json .

# # run the app
# USER bun
# EXPOSE 3000/tcp
# ENTRYPOINT [ "bun", "run", "index.ts" ]


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
