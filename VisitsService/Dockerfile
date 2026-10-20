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
COPY VisitsService/package.json VisitsService/package-lock.json ./VisitsService/
RUN cd VisitsService && npm ci --omit=dev

# Copy service source
COPY VisitsService/src ./VisitsService/src
RUN mkdir -p VisitsService/uploads
RUN chown -R node:node /app/VisitsService

WORKDIR /app/VisitsService

EXPOSE 3003

ENV NODE_ENV=production
USER node
CMD ["npm", "start"]
