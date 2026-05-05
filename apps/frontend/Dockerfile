FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/frontend/package.json apps/frontend/package.json
RUN npm ci

FROM deps AS build
ARG VITE_API_BASE_URL=http://localhost:3000/api
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
COPY tsconfig.base.json ./
COPY apps/frontend apps/frontend
RUN npm run build -w apps/frontend

FROM node:22-alpine AS runner
WORKDIR /app
RUN npm install -g serve
COPY --from=build /app/apps/frontend/dist apps/frontend/dist
EXPOSE 5173
CMD ["serve", "-s", "apps/frontend/dist", "-l", "5173"]
