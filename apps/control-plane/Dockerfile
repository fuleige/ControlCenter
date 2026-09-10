FROM node:24-bookworm-slim AS build
WORKDIR /workspace

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY apps/control-plane/package.json apps/control-plane/package.json
COPY apps/agent/package.json apps/agent/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci

COPY packages/protocol packages/protocol
COPY apps/control-plane apps/control-plane
RUN npm run build -w @controller-center/protocol && npm run build -w @controller-center/control-plane
RUN npm prune --omit=dev

FROM node:24-bookworm-slim
WORKDIR /workspace
ENV NODE_ENV=production CONTROL_DATA_DIR=/data CONTROL_PORT=8787
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build /workspace/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /workspace/apps/control-plane/package.json ./apps/control-plane/package.json
COPY --from=build /workspace/apps/control-plane/dist ./apps/control-plane/dist
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "apps/control-plane/dist/index.js"]
