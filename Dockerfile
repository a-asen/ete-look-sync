# Headless ete-look-sync runner.
#
# Bundles Node + the exact Playwright Chromium build into one image so a
# host needs only Docker — no host Node/npm install and no host Chromium
# system libraries. The silent OWA token refresh replays the persistent
# Chromium profile, so the browser must live inside the same image as the
# CLI; pinning the base to the Playwright version in package.json keeps
# that Chromium build identical to the one `ete-look-sync login` uses on a
# workstation, so a profile captured there replays here.
#
# Run it with the state + config dirs bind-mounted and the paths exported:
#   docker run --rm \
#     -e ETE_LOOK_SYNC_STATE_DIR=/state \
#     -e ETE_LOOK_SYNC_CONFIG=/config/config.toml \
#     -v /path/to/state:/state \
#     -v /path/to/config:/config:ro \
#     d9-ete-look-sync:latest sync-once
FROM mcr.microsoft.com/playwright:v1.60.0-noble

WORKDIR /app

# Dependency layer first so source edits don't re-resolve the tree.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm install -g .

# State + config come from the environment at run time.
ENTRYPOINT ["ete-look-sync"]
CMD ["--help"]
