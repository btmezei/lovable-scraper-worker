FROM node:20-slim

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
