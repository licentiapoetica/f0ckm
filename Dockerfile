FROM node:22-alpine
ARG GIT_HASH=unknown
ENV GIT_HASH=$GIT_HASH

RUN apk add --no-cache \
    ffmpeg \
    yt-dlp \
    ffmpegthumbnailer \
    imagemagick \
    ghostscript \
    git \
    mailcap \
    file \
    curl \
    torsocks \
    exiftool

WORKDIR /opt/f0bm
COPY . .

RUN npm i
RUN npm run build

ENTRYPOINT ["npm", "run", "start"]
