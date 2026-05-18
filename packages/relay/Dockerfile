FROM node:20-alpine AS builder
WORKDIR /app
# Build tools required for better-sqlite3 native compilation
RUN apk add --no-cache python3 make g++
COPY package.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build
# Prune to production deps (keeps the compiled .node binary)
RUN npm prune --omit=dev

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
# Copy compiled node_modules from builder — includes better-sqlite3 native binary.
# Do NOT reinstall here: re-running npm install without build tools would miss the native addon.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8787
CMD ["node", "dist/index.js"]
