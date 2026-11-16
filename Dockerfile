# Multi-stage build for the Next.js app (app/), served by the standalone server on $PORT.
# Data: files in data/v1/ (fetched by scripts/fetch-data.sh before deploy) are baked into the
# image; without them the image falls back to contracts/mock.

FROM node:24-slim AS deps
WORKDIR /repo/app
COPY app/package.json app/package-lock.json ./
RUN npm ci

FROM node:24-slim AS build
WORKDIR /repo
COPY --from=deps /repo/app/node_modules app/node_modules
COPY app app
COPY contracts contracts
COPY docs docs
COPY pipeline/regions.geojson pipeline/regions.geojson
ENV NEXT_TELEMETRY_DISABLED=1
ARG NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=""
ENV NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=$NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
# git does not keep empty folders; the run stage copies app/public even when it has no files.
RUN mkdir -p app/public && cd app && npm run build

# Pick the dataset: real files if present, mock otherwise.
FROM node:24-slim AS data
# Listing contracts/mock as a second source keeps COPY valid when data/ does not exist.
COPY contracts/mock/ data* /data-src/
RUN if [ -f /data-src/v1/monthly.parquet ]; then cp -r /data-src/v1 /data; \
    else mkdir /data && cp /data-src/*.parquet /data-src/*.json /data/; fi

FROM node:24-slim AS run
WORKDIR /srv
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=8080 \
    APP_DATA_DIR=/srv/data \
    METHOD_DOC_PATH=/srv/docs/METHOD.md
COPY --from=build /repo/app/.next/standalone ./
COPY --from=build /repo/app/.next/static ./.next/static
COPY --from=build /repo/app/public ./public
COPY --from=data /data ./data
COPY --from=build /repo/docs/METHOD.md ./docs/METHOD.md
USER node
EXPOSE 8080
CMD ["node", "server.js"]
