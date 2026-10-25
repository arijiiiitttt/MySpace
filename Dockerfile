# One container serves the website and the game server on a single port.
FROM node:22-alpine AS build
WORKDIR /app
COPY client/package*.json client/
RUN npm ci --prefix client
COPY client client
RUN npm run build --prefix client

FROM node:22-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY server/package*.json server/
RUN npm ci --omit=dev --prefix server
COPY server server
COPY --from=build /app/client/dist client/dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/health || exit 1
CMD ["node", "server/src/index.js"]
