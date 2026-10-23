# صورة تشغيل منصة انسياب: تبني الواجهة وتشغّل الخادم الذي يخدمها مع الواجهة البرمجية.
FROM node:22-bookworm-slim
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
COPY packages/core/package.json packages/core/
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production MODE=live PORT=8787 DATA_DIR=/data
VOLUME /data
EXPOSE 8787
CMD ["npm", "run", "start", "-w", "@ansiyab/server"]
