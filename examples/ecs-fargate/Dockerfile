# Multi-stage Dockerfile for Next.js 16 + @leejpsd/nextjs-cache-handler on
# AWS ECS Fargate (or any Docker runtime).
#
# Critical: DEPLOYMENT_VERSION must be re-declared in the runner stage,
# not just the builder. Multi-stage ARG/ENV does not inherit across
# stages, and missing the runtime ENV is the root cause of the
# "static-chunk-404 after deploy" failure mode that BUILD_NAMESPACE
# isolation is designed to prevent.

# ───── Builder ────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

ARG DEPLOYMENT_VERSION=dev-build
ENV DEPLOYMENT_VERSION=$DEPLOYMENT_VERSION

WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund

COPY . .
# `next build` runs the cacheHandlers prerender pass. The library's
# build-phase skip (NEXT_PHASE=phase-production-build) ensures Redis is
# not contacted here, so REDIS_URL is intentionally unset.
RUN npm run build

# ───── Runner ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner

# IMPORTANT: re-declare ARG/ENV. Multi-stage builds do NOT inherit them.
ARG DEPLOYMENT_VERSION=dev-build
ENV DEPLOYMENT_VERSION=$DEPLOYMENT_VERSION
# GIT_HASH is the secondary fallback the handler reads if DEPLOYMENT_VERSION
# isn't set. Aliasing them keeps both paths safe.
ENV GIT_HASH=$DEPLOYMENT_VERSION
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup -S nextjs && adduser -S nextjs -G nextjs

WORKDIR /app
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nextjs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nextjs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
