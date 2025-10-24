FROM node:22.14-alpine AS build

WORKDIR /app

ADD . .
RUN npm i && npm run build && npm run bundle


FROM node:22.14-alpine

WORKDIR /app

RUN apk add --no-cache ffmpeg yt-dlp
RUN npm install sharp
COPY --from=build /app/dist/bundle.cjs /app/bundle.cjs

ENV YTDLP_BIN_PATH=/usr/bin/yt-dlp
ENV FFMPEG_BIN_PATH=/usr/bin/ffmpeg

ENTRYPOINT ["node", "bundle.cjs"]