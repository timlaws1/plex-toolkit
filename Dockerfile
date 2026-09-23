FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY src ./src
COPY docs ./docs
COPY tools ./tools

RUN npm run css \
  && npm prune --omit=dev

ARG APP_REVISION=dev
ARG APP_VERSION=1.0.0
ENV NODE_ENV=production
ENV PORT=8787
ENV DATA_DIR=/data
ENV APP_REVISION=$APP_REVISION
ENV APP_VERSION=$APP_VERSION

RUN mkdir -p /data/config /data/database /data/plugins /data/logs \
  && chown -R node:node /data /app

USER node
EXPOSE 8787
VOLUME ["/data"]

CMD ["node", "src/index.js"]
