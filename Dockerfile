FROM node:22-slim AS build

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY API/package.json API/
COPY Auth/package.json Auth/

RUN npm ci --workspace API --include-workspace-root

COPY API/ API/
COPY tsconfig.base.json ./

RUN npm run prisma:generate --workspace API
RUN npm run build --workspace API

FROM node:22-slim AS runtime

RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY API/package.json API/

RUN npm ci --workspace API --include-workspace-root --omit=dev

COPY --from=build /app/API/dist/ API/dist/
COPY --from=build /app/API/prisma/ API/prisma/
COPY --from=build /app/node_modules/.prisma/ node_modules/.prisma/
COPY --from=build /app/node_modules/@prisma/ node_modules/@prisma/

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000

CMD ["node", "API/dist/server.js"]
