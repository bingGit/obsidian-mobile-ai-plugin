FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server.js ./

ENV PORT=8787
ENV HOST=0.0.0.0
ENV UPSTREAM_TIMEOUT_MS=180000

EXPOSE 8787

CMD ["node", "server.js"]
