FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/frontend/package.json apps/frontend/package.json
RUN npm ci

FROM deps AS build
COPY tsconfig.base.json ./
COPY apps/backend apps/backend
RUN npm run build -w apps/backend

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/package.json
RUN npm ci --omit=dev -w apps/backend
COPY --from=build /app/apps/backend/dist apps/backend/dist
EXPOSE 3000
CMD ["node", "apps/backend/dist/main.js"]
