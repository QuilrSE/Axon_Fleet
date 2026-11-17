FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY scripts ./scripts
RUN npm ci --omit=dev --workspaces --include-workspace-root
ENV NODE_ENV=production
# Service is chosen by the compose "command"
CMD ["node", "scripts/start-all.mjs"]
