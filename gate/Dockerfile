ARG node=24.15.0-alpine

FROM node:${node} AS build
RUN corepack enable
ENV HUSKY=0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY gate/package.json gate/package.json
COPY packages/example-ui/package.json packages/example-ui/package.json
RUN pnpm install --ignore-scripts --filter magic-sso-gate --frozen-lockfile
COPY gate gate
COPY packages/example-ui packages/example-ui
RUN pnpm --filter magic-sso-gate build

FROM node:${node} AS prod-deps
RUN corepack enable
ENV HUSKY=0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY gate/package.json gate/package.json
COPY packages/example-ui/package.json packages/example-ui/package.json
RUN pnpm install --ignore-scripts --filter magic-sso-gate --prod --frozen-lockfile

FROM node:${node}
RUN addgroup -S -g 1001 nodejs
RUN adduser -S -u 1001 -G nodejs gate
WORKDIR /app
COPY --from=prod-deps --chown=gate:nodejs /app/node_modules node_modules
COPY --from=prod-deps --chown=gate:nodejs /app/gate/node_modules gate/node_modules
COPY --chown=gate:nodejs gate/package.json gate/package.json
COPY --from=build --chown=gate:nodejs /app/gate/dist gate/dist
COPY --chown=gate:nodejs packages/example-ui packages/example-ui
USER gate
WORKDIR /app/gate
EXPOSE 4000
HEALTHCHECK --interval=5m --timeout=3s CMD ["node", "-e", "fetch('http://127.0.0.1:4000/_magicgate/healthz').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
