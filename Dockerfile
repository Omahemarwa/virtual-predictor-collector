FROM mcr.microsoft.com/playwright:v1.61.1-noble

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/app/data

COPY package.json package-lock.json ./
RUN npm install --omit=dev

COPY collector.mjs entrypoint.sh ./
RUN chmod +x /app/entrypoint.sh && mkdir -p /app/data

EXPOSE 8080
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "collector.mjs", "--serve"]
