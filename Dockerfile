
# Build the Go email verification service
FROM golang:1.22-bookworm AS go-builder

WORKDIR /src
COPY . .

WORKDIR /src/backend/go
RUN go mod download && \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/verifier .

# Build the Node.js dashboard
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libcurl4 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

# Include the compiled Go verifier
COPY --from=go-builder /out/verifier /usr/local/bin/verifier

ENV NODE_ENV=production
ENV PORT=5000
ENV VERIFIER_GO_PORT=8080

EXPOSE 5000

# Start both services
CMD ["sh", "-c", "/usr/local/bin/verifier & exec node server.js"]
