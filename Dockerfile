# Build stage: compile the TypeScript auditor.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage: compiled output only, no dev dependencies.
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
ENTRYPOINT ["node", "dist/cli.js"]
