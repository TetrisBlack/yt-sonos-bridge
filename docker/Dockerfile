FROM node:22.14-alpine AS build

WORKDIR /app

ADD . .
RUN npm i && npm run build && npm run bundle


FROM node:22.14-alpine

WORKDIR /app

RUN apk add --no-cache ffmpeg
RUN npm install sharp
COPY --from=build /app/dist/bundle.cjs /app/bundle.cjs

ENTRYPOINT ["node", "bundle.cjs"]