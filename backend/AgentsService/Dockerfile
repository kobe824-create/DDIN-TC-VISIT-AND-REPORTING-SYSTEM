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

COPY AgentsService/package.json AgentsService/package-lock.json ./AgentsService/
RUN cd AgentsService && npm ci --omit=dev

COPY AgentsService/src ./AgentsService/src
RUN mkdir -p AgentsService/uploads
RUN chown -R node:node /app

WORKDIR /app/AgentsService
EXPOSE 3002
ENV NODE_ENV=production
USER node
CMD ["npm", "start"]
