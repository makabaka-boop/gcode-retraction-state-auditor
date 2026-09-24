# Build stage: compile TypeScript.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage: only the compiled output and production files.
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY --from=build /app/dist ./dist

# The container audits a G-code file mounted at /input and a threshold passed
# as the retraction floor in thousandths, e.g.:
#   docker compose run --rm motion-audit /input/part.gcode 2000
ENTRYPOINT ["node", "/app/dist/cli.js"]
