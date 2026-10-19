FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS api
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 3000
CMD ["npm", "run", "start", "--workspace", "apps/api"]

FROM api AS worker
CMD ["npm", "run", "start", "--workspace", "apps/worker"]

FROM nginx:1.29-alpine AS web-base
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

FROM web-base AS checkout
COPY --from=build /app/apps/checkout/dist /usr/share/nginx/html

FROM web-base AS dashboard
COPY --from=build /app/apps/dashboard/dist /usr/share/nginx/html
