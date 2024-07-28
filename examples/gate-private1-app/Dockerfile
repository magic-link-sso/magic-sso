ARG node=24.15.0-alpine

FROM node:${node} AS build
RUN corepack enable
ENV HUSKY=0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY examples/gate-private1-app/package.json examples/gate-private1-app/package.json
RUN pnpm install --ignore-scripts --filter example-app-gate-private1 --frozen-lockfile
COPY examples/gate-private1-app examples/gate-private1-app
RUN pnpm --filter example-app-gate-private1 build

FROM node:${node} AS prod-deps
RUN corepack enable
ENV HUSKY=0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY examples/gate-private1-app/package.json examples/gate-private1-app/package.json
RUN pnpm install --ignore-scripts --filter example-app-gate-private1 --prod --frozen-lockfile

FROM node:${node}
RUN addgroup -S -g 1001 nodejs
RUN adduser -S -u 1001 -G nodejs upstream
WORKDIR /app
COPY --from=prod-deps --chown=upstream:nodejs /app/node_modules node_modules
COPY --from=prod-deps --chown=upstream:nodejs /app/examples/gate-private1-app/node_modules examples/gate-private1-app/node_modules
COPY --chown=upstream:nodejs examples/gate-private1-app/package.json examples/gate-private1-app/package.json
COPY --from=build --chown=upstream:nodejs /app/examples/gate-private1-app/dist examples/gate-private1-app/dist
USER upstream
WORKDIR /app/examples/gate-private1-app
EXPOSE 3007
HEALTHCHECK --interval=5m --timeout=3s CMD ["node", "-e", "fetch('http://127.0.0.1:3007/healthz').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
