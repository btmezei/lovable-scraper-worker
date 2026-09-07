FROM node:20-slim

# Chromium is required for the proxy transport lane: .gov workforce portals
# (CalJOBS and friends) are refused by Bright Data policy, so those sweeps run
# a local browser through VOS_PROXY_URL instead of the remote browser API.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-liberation ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV CHROME_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_DOWNLOAD=1

WORKDIR /app
COPY package.json ./
ENV NODE_ENV=development
RUN npm install --include=dev
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json && npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/server.js"]
