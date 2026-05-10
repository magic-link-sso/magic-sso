ARG node=24.15.0-alpine

FROM node:${node} AS build
RUN corepack enable
ENV HUSKY=0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config-core/package.json packages/config-core/package.json
COPY manager/package.json manager/package.json
RUN pnpm install --ignore-scripts --filter magic-sso-manager... --frozen-lockfile
COPY packages/config-core packages/config-core
COPY manager manager
RUN pnpm --filter magic-sso-manager build

FROM node:${node} AS prod-deps
RUN corepack enable
ENV HUSKY=0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config-core/package.json packages/config-core/package.json
COPY manager/package.json manager/package.json
RUN pnpm install --ignore-scripts --filter magic-sso-manager... --prod --frozen-lockfile

FROM node:${node}
RUN addgroup -S -g 1001 nodejs
RUN adduser -S -u 1001 -G nodejs manager
WORKDIR /app
COPY --from=prod-deps --chown=manager:nodejs /app/node_modules node_modules
COPY --from=prod-deps --chown=manager:nodejs /app/manager/node_modules manager/node_modules
COPY --from=build --chown=manager:nodejs /app/packages/config-core packages/config-core
COPY --chown=manager:nodejs manager/package.json manager/package.json
COPY --from=build --chown=manager:nodejs /app/manager/dist manager/dist
USER manager
WORKDIR /app/manager
EXPOSE 4311
HEALTHCHECK --interval=5m --timeout=3s CMD ["node", "-e", "fetch('http://127.0.0.1:4311/healthz').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
