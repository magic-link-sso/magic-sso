ARG node=24.15.0-alpine

FROM node:${node} AS build
RUN corepack enable
ENV HUSKY=0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY examples/photos/package.json examples/photos/package.json
COPY packages/nextjs/package.json packages/nextjs/package.json
RUN pnpm install --ignore-scripts --filter example-app-photos --frozen-lockfile
COPY examples/photos examples/photos
COPY packages/nextjs packages/nextjs
RUN pnpm --filter example-app-photos build

FROM node:${node}
RUN addgroup -S -g 1001 nodejs
RUN adduser -S -u 1001 -G nodejs nextjs
WORKDIR /app
COPY --from=build --chown=nextjs:nodejs /app/examples/photos/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/examples/photos/.next/static ./examples/photos/.next/static
COPY --from=build --chown=nextjs:nodejs /app/examples/photos/public ./examples/photos/public
USER nextjs
WORKDIR /app/examples/photos
EXPOSE 5001
HEALTHCHECK --interval=5m --timeout=3s CMD ["node", "-e", "fetch('http://127.0.0.1:5001/login').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]
