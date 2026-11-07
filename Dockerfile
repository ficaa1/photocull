# PhotoCull server: the culling app as a self-hosted web app (docs/server.md).
FROM node:24-bookworm-slim
# ExifTool, which reads RAW previews and metadata, is a Perl program.
RUN apt-get update && apt-get install -y --no-install-recommends perl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY LICENSE THIRD_PARTY_NOTICES.md ./
# Checkouts made with a private umask would otherwise be unreadable to the container user.
RUN chmod -R a+rX /app
ENV NODE_ENV=production HOME=/tmp \
    PHOTOCULL_DATA_DIR=/data PHOTOCULL_HOST=0.0.0.0 PHOTOCULL_PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PHOTOCULL_PORT+'/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/backend.cjs", "--server"]
