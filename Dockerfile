FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY docs ./docs

ENV NODE_ENV=production
ENV PORT=8787
ENV DATA_DIR=/data

RUN mkdir -p /data/config /data/database /data/plugins /data/logs \
  && chown -R node:node /data /app

USER node
EXPOSE 8787
VOLUME ["/data"]

CMD ["node", "src/index.js"]
