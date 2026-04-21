FROM node:22-slim AS build

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY API/package.json API/
COPY Auth/package.json Auth/
COPY Admin/package.json Admin/

RUN pnpm install --frozen-lockfile

COPY API/ API/
COPY Auth/ Auth/
COPY Admin/ Admin/
COPY assets/ assets/
COPY tsconfig.base.json ./

RUN pnpm --filter @uoa/api prisma:generate
RUN pnpm --filter @uoa/api build
RUN pnpm --filter @uoa/auth build
RUN pnpm --filter @uoa/admin build

FROM node:22-slim AS runtime

RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY API/package.json API/
COPY Auth/package.json Auth/
COPY Admin/package.json Admin/
COPY API/prisma/ API/prisma/

RUN pnpm install --frozen-lockfile --filter @uoa/api... --filter @uoa/auth...
RUN pnpm --filter @uoa/api prisma:generate

COPY --from=build /app/API/dist/ API/dist/
COPY --from=build /app/API/prisma/ API/prisma/
COPY --from=build /app/Auth/dist/ Auth/dist/
COPY --from=build /app/Auth/dist-ssr/ Auth/dist-ssr/
COPY --from=build /app/Admin/dist/ Admin/dist/

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000

CMD ["sh", "-c", "pnpm --filter @uoa/api exec prisma migrate deploy --schema prisma/schema.prisma && node API/dist/server.js"]
