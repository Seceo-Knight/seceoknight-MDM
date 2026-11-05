# syntax=docker/dockerfile:1.7
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
# Use `npm ci` when a lockfile exists (reproducible), otherwise fall back to
# `npm install` so the first build works without a checked-in lock.
RUN if [ -f package-lock.json ]; then npm ci; else npm install --no-audit --no-fund; fi
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY proxy.inc /etc/nginx/conf.d/proxy.inc
EXPOSE 80
