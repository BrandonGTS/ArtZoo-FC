# syntax=docker/dockerfile:1

# Keep the exact Node version aligned with .node-version. The digest pins the
# official multi-platform image; build and runtime use the same glibc family.
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

FROM base AS deps
RUN npm install --global pnpm@12.9.1 --ignore-scripts --no-audit --no-fund
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version ./
COPY patches/ ./patches/
COPY apps/web/package.json ./apps/web/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/media/package.json ./packages/media/package.json
# Do not copy .npmrc: it may contain operator credentials. These are the current
# public registry and strict-peer settings. Install build dependencies as well.
RUN --mount=type=cache,id=artzoo-pnpm,target=/pnpm/store \
    test "$(node --version)" = "v$(cat .node-version)" \
    && test "$(pnpm --version)" = "12.9.1" \
    && pnpm install --frozen-lockfile --strict-peer-dependencies \
       --registry=https://registry.npmjs.org/ --store-dir=/pnpm/store

FROM deps AS build
# .dockerignore is an allowlist. No host node_modules, generated Prisma client,
# database, uploads or secrets are available to this build. No DB is required.
COPY . .
RUN pnpm build

FROM build AS worker-package
# Change packaging metadata only inside this disposable build stage. Include
# emitted code (including db/dist/generated and media/dist/bitmap-worker.mjs)
# explicitly, regardless of pack/git ignore rules. Repository files stay intact.
RUN node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
for (const directory of ['apps/worker', 'packages/domain', 'packages/db', 'packages/media']) {
  const path = `${directory}/package.json`;
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.files = ['dist'];
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
}
JS
RUN --mount=type=cache,id=artzoo-pnpm,target=/pnpm/store \
    pnpm --filter @artzoo/worker deploy --prod --frozen-lockfile \
      --registry=https://registry.npmjs.org/ --store-dir=/pnpm/store /out/worker

# The standalone bitmap thread needs its own portable dependency tree. Next's
# traced output includes the thread file but may omit its sharp resolution path.
FROM worker-package AS media-package
RUN --mount=type=cache,id=artzoo-pnpm,target=/pnpm/store \
    pnpm --filter @artzoo/media deploy --prod --frozen-lockfile \
      --registry=https://registry.npmjs.org/ --store-dir=/pnpm/store /out/media

# Shared runtime identity: the official node user is UID/GID 1000. Mounts must
# preserve this ownership; never fix a mounted directory with chmod 777.
# Compose must mount persistent storage for BOTH web and worker. No anonymous
# VOLUME is declared here; container-local storage is only for disposable checks.
FROM base AS runtime
ENV NODE_ENV=production \
    ARTZOO_DEPLOYMENT_ENV=production \
    ARTZOO_AVATAR_DIR=/app/storage/avatars
RUN install -d -m 0755 /app/storage \
    && install -d -o node -g node -m 0700 \
       /app/storage/original /app/storage/derived /app/storage/avatars
STOPSIGNAL SIGTERM

FROM runtime AS worker
COPY --from=worker-package /out/worker/ /app/
USER node
ENTRYPOINT ["node", "/app/dist/index.js"]
CMD ["--require-db"]

# Maintenance is opt-in. Keep pnpm, Prisma CLI, TypeScript, compiled shared
# packages, migrations and the existing guarded console entry point. Do not
# copy the Next build or original art assets into this image.
FROM deps AS tools
COPY --from=build /app/packages/ /app/packages/
COPY --from=build /app/apps/web/server/auth/ /app/apps/web/server/auth/
COPY scripts/auth-cli-loader.mjs scripts/media-baseline-cli.mjs /app/scripts/
ENV NODE_ENV=production
USER node
ENTRYPOINT []
CMD ["node", "-e", "console.log('ArtZoo maintenance image: specify an explicit command. Nothing was changed.')"]

# Last target is web, so an untargeted docker build produces the website image.
FROM runtime AS web
# Monorepo standalone preserves apps/web relative to the tracing root (/app).
COPY --from=build /app/apps/web/.next/standalone/ /app/
COPY --from=build /app/apps/web/.next/static/ /app/apps/web/.next/static/
COPY --from=build /app/apps/web/public/ /app/apps/web/public/
# Scope these dependencies to the emitted media files, without merging pnpm
# symlinks into Next's separately traced node_modules tree.
COPY --from=media-package /out/media/node_modules/ /app/packages/media/dist/node_modules/
# Only the Next cache is writable; application code remains root-owned.
RUN install -d -o node -g node -m 0700 /app/apps/web/.next/cache \
    && chown -R node:node /app/apps/web/.next/cache
ENV HOSTNAME=0.0.0.0 \
    PORT=3100
USER node
EXPOSE 3100
RUN node -e "require('node:module').createRequire('/app/packages/media/dist/bitmap-worker.mjs')('sharp')"
ENTRYPOINT ["node", "/app/apps/web/server.js"]
