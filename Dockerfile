# Multi-stage build.
# Stage 1 compiles TypeScript with all dev tools.
# Stage 2 is a small runtime image with production dependencies only.
# WHY: a smaller image means faster deploys and fewer packages that could contain vulnerabilities.
# Compilers and test tools never ship to production.

# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# `npm ci` installs EXACTLY what package-lock.json says, so builds are reproducible.
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# ---------- runtime ----------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Run as the unprivileged "node" user. A compromised process then cannot modify the image or the host.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json
# The ONLY writable directory: the local SFTP stand-in. /app itself stays root-owned and read-only for
# the app. (Found by the container smoke test: without this, mkdir failed with EACCES.)
# In the cloud, mount a volume here, or use a real SFTP adapter.
RUN mkdir -p /app/runtime-data && chown node:node /app/runtime-data
USER node
EXPOSE 3000
# Orchestrators (ECS, Docker) use this to restart an unhealthy container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "dist/middleware/src/server.js"]
