FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
RUN chown -R node:node /app

EXPOSE 3000
ENV NODE_ENV=production
USER node
CMD ["npm", "start"]
