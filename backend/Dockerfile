FROM node:20-alpine
WORKDIR /app

# Install build dependencies mostly for bcrypt
RUN apk add --no-cache python3 make g++ 

COPY package*.json ./
RUN npm install --production

COPY . .

ENV NODE_ENV=production
ENV PORT=5000

EXPOSE 5000
CMD ["node", "index.js"]
