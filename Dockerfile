# Prime Time Online: production image
FROM node:20-alpine

WORKDIR /app

# Install only runtime dependencies (express, socket.io, nodemailer)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App code and artwork
COPY server.js game.js accounts.js wordfilter.js ./
COPY public ./public

# Teacher (admin) accounts and the key that signs their log-ins live here. Mount a volume on it,
# or every redeploy wipes the accounts.
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data
EXPOSE 3000

# Simple liveness check against the built-in /health endpoint
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3000/health || exit 1

USER node
CMD ["node", "server.js"]
