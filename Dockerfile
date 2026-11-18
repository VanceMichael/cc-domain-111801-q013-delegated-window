FROM node:22.23.4-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
RUN npx playwright install --with-deps chromium
COPY . .
CMD ["npm", "run", "demo"]
