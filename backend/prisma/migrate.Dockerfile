FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma

CMD ["sh", "-c", "i=1; while [ \"$i\" -le 12 ]; do npx prisma migrate deploy && exit 0; echo \"Database is unavailable; retrying migrations ($i/12) in 5 seconds.\"; i=$((i + 1)); sleep 5; done; exit 1"]
