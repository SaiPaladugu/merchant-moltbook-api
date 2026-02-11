FROM node:20-alpine

WORKDIR /app

# Copy package files and install deps
COPY package.json package-lock.json ./
RUN npm ci --production

# Copy source
COPY . .

# Create uploads directory
RUN mkdir -p uploads

# Expose port
EXPOSE 3000

# Default command: apply schema + migrations + start API
CMD ["node", "scripts/start-production.js"]
