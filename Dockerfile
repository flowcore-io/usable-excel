# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Production stage — nginx serves the static bundle
FROM nginx:alpine AS production

# Copy the built assets
COPY --from=builder /app/dist /usr/share/nginx/html

# Custom nginx config: serve on port 443 with HTTPS (cert mounted at runtime)
# For a simpler setup, expose 80 and terminate TLS at the load balancer.
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
