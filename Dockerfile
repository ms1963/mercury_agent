# Mercury — self-hosted agentic AI platform
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
RUN npm ci && npm run build && npm prune --omit=dev

FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
COPY locales ./locales
COPY docs ./docs
COPY skills ./skills
COPY workflows ./workflows
COPY personalities ./personalities
COPY tools ./tools
ENV NODE_ENV=production MERCURY_HOME=/data
# /data is written at runtime as the non-root `node` user, so it must own it.
RUN mkdir -p /data && chown -R node:node /data
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "packages/cli/dist/bin.js", "serve", "--host", "0.0.0.0", "--port", "3000"]
