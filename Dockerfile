FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY index.html tsconfig.json vite.config.ts ./
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
COPY --from=build --chown=node:node /app/server/app.ts /app/server/index.ts /app/server/store.ts /app/server/hermes.ts /app/server/integrations.ts /app/server/oauth.ts /app/server/providers.ts /app/server/push.ts ./server/
COPY --from=build --chown=node:node /app/src/model.ts ./src/model.ts
COPY --from=build --chown=node:node /app/src/calendar-time.ts ./src/calendar-time.ts
COPY --from=build --chown=node:node /app/src/hermes-model.ts ./src/hermes-model.ts
COPY --from=build --chown=node:node /app/package.json ./package.json
USER node
EXPOSE 8789
CMD ["node", "server/index.ts"]
