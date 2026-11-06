
# Build the Node.js dashboard
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libcurl4 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=5000

EXPOSE 5000

# Reacher is the only engine now; there is no Go verifier to start.
CMD ["node", "server.js"]
