FROM node:24-slim
WORKDIR /app
COPY *.mjs install.sh ./
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
EXPOSE 8080
CMD ["node", "--no-warnings", "server.mjs"]
