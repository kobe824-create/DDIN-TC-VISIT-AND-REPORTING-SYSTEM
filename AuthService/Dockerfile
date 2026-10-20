FROM node:22-bookworm-slim

WORKDIR /app

# Install OpenSSL required by Prisma
RUN apt-get update \
    && apt-get install -y openssl \
    && rm -rf /var/lib/apt/lists/*

# Install root-level dependencies (Prisma client)
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY shared ./shared

RUN npm ci --omit=dev
RUN npx prisma generate

# Install service dependencies
COPY AuthService/package.json AuthService/package-lock.json ./AuthService/
RUN cd AuthService && npm ci --omit=dev

# Copy service source
COPY AuthService/src ./AuthService/src
RUN mkdir -p AuthService/uploads
RUN chown -R node:node /app

WORKDIR /app/AuthService

EXPOSE 3001

ENV NODE_ENV=production
USER node
CMD ["npm", "start"]
