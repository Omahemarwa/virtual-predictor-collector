FROM mcr.microsoft.com/playwright:focal
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npx playwright install firefox && rm -rf /root/.cache

COPY . .
RUN mkdir -p /app/data

CMD ["node", "collector.mjs", "--serve"]
