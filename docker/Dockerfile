FROM node:22.14-alpine AS build

WORKDIR /app

ADD . .
RUN npm i && npm run build && npm run bundle


FROM node:22.14-alpine

WORKDIR /app

RUN apk add --no-cache ffmpeg curl python3
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o ./yt-dlp
RUN chmod a+rx ./yt-dlp
RUN npm install sharp
COPY --from=build /app/dist/bundle.cjs /app/bundle.cjs

ENV YTDLP_BIN_PATH=/app/yt-dlp
ENV FFMPEG_BIN_PATH=/usr/bin/ffmpeg

ENTRYPOINT ["node", "bundle.cjs"]