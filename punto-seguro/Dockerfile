# ============================================
# PUNTO SEGURO — Dockerfile de producción
# Etapa 1: build del cliente (Vite) → archivos estáticos
# Etapa 2: imagen final que sirve el backend Express
#          (API + archivos estáticos del cliente)
# ============================================

# ---------- Etapa 1: build del frontend ----------
FROM node:20-alpine AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ---------- Etapa 2: backend + estáticos ----------
FROM node:20-alpine AS runtime
WORKDIR /app

# Instala solo dependencias de producción del servidor
COPY server/package*.json ./server/
RUN npm ci --omit=dev --prefix ./server

# Copia el código del servidor
COPY server/ ./server/

# Copia el build del cliente para que el servidor lo sirva como estático
COPY --from=client-build /app/client/dist ./client/dist

ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000

WORKDIR /app/server
CMD ["node", "src/server.js"]
