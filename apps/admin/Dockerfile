FROM oven/bun:1.3-alpine
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
ARG NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
RUN bun --filter @bid/admin run build
WORKDIR /app/apps/admin
ENV NODE_ENV=production PORT=3001
EXPOSE 3001
CMD ["bun", "run", "start"]
