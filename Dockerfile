# ─────────────────────────────────────────────────────────────────────────────
# Mana Chess backend – accounts, decks, friends, challenges, rooms, control panel (/admin).
#
# Two stages: the TypeScript is bundled into one file with the build tools, then only that file
# goes into a distroless Node.js image – no shell, no package manager, no npm packages at run
# time – running as an unprivileged user (uid 65532). Data lives in /data (mount a volume there).
#
#   docker build -t mana-chess-backend .
#   docker run -d -p 8787:8787 -v mana-chess-data:/data --read-only --cap-drop ALL mana-chess-backend
# ─────────────────────────────────────────────────────────────────────────────

# ── 1. build (runs on the build machine's own platform; the output is plain JavaScript) ──
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
COPY . .
RUN node scripts/build.mjs && mkdir -p /out/data

# ── 2. run ──
FROM gcr.io/distroless/nodejs22-debian12:nonroot
LABEL org.opencontainers.image.title="Mana Chess backend" \
      org.opencontainers.image.description="Accounts, server-side decks, friends, challenges, game rooms and a web control panel for Mana Chess"
WORKDIR /app
COPY --from=build /src/dist/backend.mjs /src/dist/healthcheck.mjs /app/
# /data belongs to the run user and only to it; an empty Docker volume mounted there takes both over
COPY --from=build --chown=65532:65532 --chmod=700 /out/data /data
ENV NODE_ENV=production \
    PORT=8787 \
    MANA_DATA=/data
USER 65532:65532
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["/nodejs/bin/node", "/app/healthcheck.mjs"]
# extra arguments go after the image name, e.g.: docker compose run --rm backend --setup
ENTRYPOINT ["/nodejs/bin/node", "/app/backend.mjs", "--no-open"]
