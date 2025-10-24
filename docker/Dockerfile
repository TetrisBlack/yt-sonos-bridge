FROM node:22-alpine AS build

WORKDIR /app

ADD . .
RUN npm ci && npm run build && npm run bundle


FROM node:22-alpine

WORKDIR /app

RUN apk upgrade --no-cache && \
    apk add --no-cache ffmpeg curl python3 && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o ./yt-dlp && \
    chmod a+rx ./yt-dlp && \
    npm install sharp && \
    apk del curl

COPY --from=build /app/dist/bundle.mjs /app/bundle.mjs

ENV YTDLP_BIN_PATH=/app/yt-dlp
ENV FFMPEG_BIN_PATH=/usr/bin/ffmpeg

ENTRYPOINT ["node", "bundle.mjs"]