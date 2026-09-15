FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY index.html tsconfig.json vite.config.ts ./
COPY public ./public
COPY src ./src
COPY server ./server
RUN pnpm test && pnpm build
RUN pnpm prune --prod

FROM node:24-bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/semyonfox/fox-focus" \
      org.opencontainers.image.description="A self-hosted task and calendar workspace"
ENV NODE_ENV=production PORT=8789 DATA_DIR=/data
WORKDIR /app
RUN mkdir /data && chown node:node /data
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server/action-worker.ts /app/server/app.ts /app/server/hermes.ts /app/server/index.ts /app/server/integrations.ts /app/server/oauth.ts /app/server/providers.ts /app/server/push.ts /app/server/row-store.ts /app/server/store.ts /app/server/task-management.ts /app/server/task-migration.ts ./server/
COPY --from=build --chown=node:node /app/src/calendar-time.ts /app/src/hermes-model.ts /app/src/integration-model.ts /app/src/model.ts /app/src/row-model.ts ./src/
COPY --from=build --chown=node:node /app/package.json ./package.json
USER node
EXPOSE 8789
CMD ["node", "server/index.ts"]
