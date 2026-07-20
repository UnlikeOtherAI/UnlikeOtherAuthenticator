# node:22-slim pinned by manifest digest (multi-arch).
# Update digest when bumping base image: `docker buildx imagetools inspect node:22-slim`
FROM node:22-slim@sha256:689c11043dad91472750cd824c97dd5e2318e9dd6f954e492fe7af0135d33ceb AS build

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY API/package.json API/
COPY Auth/package.json Auth/
COPY Admin/package.json Admin/
COPY packages/billing-statement-protocol/package.json packages/billing-statement-protocol/

RUN pnpm install --frozen-lockfile

COPY API/ API/
COPY Auth/ Auth/
COPY Admin/ Admin/
COPY packages/billing-statement-protocol/ packages/billing-statement-protocol/
COPY assets/ assets/
COPY tsconfig.base.json ./

RUN pnpm --filter @unlikeotherai/billing-statement-protocol build
RUN pnpm --filter @uoa/api prisma:generate
RUN pnpm --filter @uoa/api build
RUN pnpm --filter @uoa/auth build
RUN pnpm --filter @uoa/admin build

FROM node:22-slim@sha256:689c11043dad91472750cd824c97dd5e2318e9dd6f954e492fe7af0135d33ceb AS runtime

RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN corepack enable

# Give the built-in non-root `node` user ownership of the workdir so pnpm
# install + prisma generate can write under it.
RUN chown -R node:node /app

USER node

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node API/package.json API/
COPY --chown=node:node Auth/package.json Auth/
COPY --chown=node:node Admin/package.json Admin/
COPY --chown=node:node packages/billing-statement-protocol/package.json packages/billing-statement-protocol/
COPY --chown=node:node API/prisma/ API/prisma/

RUN pnpm install --frozen-lockfile --filter @uoa/api... --filter @uoa/auth...
RUN pnpm --filter @uoa/api prisma:generate

COPY --from=build --chown=node:node /app/API/dist/ API/dist/
COPY --from=build --chown=node:node /app/API/prisma/ API/prisma/
COPY --from=build --chown=node:node /app/packages/billing-statement-protocol/dist/ packages/billing-statement-protocol/dist/
COPY --from=build --chown=node:node /app/packages/billing-statement-protocol/schema/ packages/billing-statement-protocol/schema/
COPY --from=build --chown=node:node /app/packages/billing-statement-protocol/fixtures/ packages/billing-statement-protocol/fixtures/
COPY --from=build --chown=node:node /app/packages/billing-statement-protocol/openapi/ packages/billing-statement-protocol/openapi/
COPY --from=build --chown=node:node /app/Auth/dist/ Auth/dist/
COPY --from=build --chown=node:node /app/Auth/dist-ssr/ Auth/dist-ssr/
COPY --from=build --chown=node:node /app/Admin/dist/ Admin/dist/

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000

CMD ["sh", "-c", "pnpm --filter @uoa/api exec prisma migrate deploy --schema prisma/schema.prisma && node API/dist/server.js"]
