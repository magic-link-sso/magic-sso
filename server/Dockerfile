ARG node=24.15.0-alpine

FROM node:${node} AS build
RUN corepack enable
ENV HUSKY=0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/package.json
RUN pnpm install --ignore-scripts --filter magic-sso-server --frozen-lockfile
COPY server server
RUN pnpm --filter magic-sso-server build

FROM node:${node} AS prod-deps
RUN corepack enable
ENV HUSKY=0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/package.json
RUN pnpm install --ignore-scripts --filter magic-sso-server --prod --frozen-lockfile

FROM node:${node}
RUN addgroup -S -g 1001 nodejs
RUN adduser -S -u 1001 -G nodejs sso
WORKDIR /app
COPY --from=prod-deps --chown=sso:nodejs /app/node_modules node_modules
COPY --from=prod-deps --chown=sso:nodejs /app/server/node_modules server/node_modules
COPY --chown=sso:nodejs server/package.json server/package.json
COPY --from=build --chown=sso:nodejs /app/server/dist server/dist
COPY --from=build --chown=sso:nodejs /app/server/src/views server/src/views
COPY --chown=sso:nodejs server/LICENSE server/LICENSE
USER sso
WORKDIR /app/server
EXPOSE 3000
HEALTHCHECK --interval=5m --timeout=3s CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
