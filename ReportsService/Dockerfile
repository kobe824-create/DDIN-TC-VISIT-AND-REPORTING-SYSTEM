FROM node:22-bookworm-slim

WORKDIR /app

# Install OpenSSL required by Prisma
RUN apt-get update \
    && apt-get install -y openssl \
    && rm -rf /var/lib/apt/lists/*


COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY shared ./shared
RUN npm ci --omit=dev
RUN npx prisma generate

COPY ReportsService/package.json ReportsService/package-lock.json ./ReportsService/
RUN cd ReportsService && npm ci --omit=dev

COPY ReportsService/src ./ReportsService/src
RUN mkdir -p ReportsService/uploads
RUN chown -R node:node /app

WORKDIR /app/ReportsService
EXPOSE 3004
ENV NODE_ENV=production
USER node
CMD ["npm", "start"]
