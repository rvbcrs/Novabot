FROM node:22-alpine
WORKDIR /app
COPY server.mjs ./
ENV PORT=3334 DATA_FILE=/data/tokens.json
VOLUME /data
EXPOSE 3334
USER node
CMD ["node", "server.mjs"]
