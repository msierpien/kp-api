# Base stage
#
# @resvg/resvg-js (rasteryzacja SVG ozdobnikow do druku) nie wymaga pakietow
# systemowych - pnpm zaciaga prebuilt binarke linux-x64-musl z lockfile.
# node-canvas SVG-a nie otwiera, wiec bez resvg ozdobnik wektorowy wychodzi
# z drukarki jako pusty prostokat.
FROM node:20-alpine AS base

# Install OpenSSL for Prisma + Python and build deps for canvas.
# fontconfig + font-liberation: bez zadnego fontu w obrazie node-canvas renderuje
# kwadraciki (tofu) zamiast tekstu. Liberation Sans jest metrycznym zamiennikiem
# Arial i fontconfig mapuje "Arial" na niego automatycznie. Czcionki dekoracyjne
# (np. Montserrat) nadal wgrywa sie przez panel (storage/fonts).
RUN apk add --no-cache openssl python3 make g++ cairo-dev jpeg-dev pango-dev giflib-dev fontconfig font-liberation

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Dependencies stage
FROM base AS dependencies
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Development stage
FROM base AS development
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY prisma ./prisma
RUN pnpm prisma generate
COPY . .
EXPOSE 3001
CMD ["pnpm", "dev"]

# Build stage
FROM base AS build
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY prisma ./prisma
RUN pnpm prisma generate
COPY . .
RUN pnpm build
RUN pnpm prune --prod

# Migration stage
FROM base AS migrate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY prisma ./prisma
CMD ["pnpm", "prisma", "migrate", "deploy"]

# Production stage
FROM base AS production
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
EXPOSE 3001
CMD ["node", "dist/index.js"]
