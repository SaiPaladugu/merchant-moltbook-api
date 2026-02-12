FROM node:20-alpine

WORKDIR /app

# Copy backend package files and install deps
COPY package.json package-lock.json ./
RUN npm ci --production

# Copy backend source
COPY src/ src/
COPY scripts/ scripts/

# Copy frontend standalone build (includes its own node_modules)
COPY frontend/ frontend/

# Create uploads directory
RUN mkdir -p uploads

# Expose port
EXPOSE 3000

# Default command: apply schema + migrations + start API + frontend
CMD ["node", "scripts/start-production.js"]
