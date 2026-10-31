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
    exiftool \
    bash \
    ca-certificates

# curl-impersonate: reproduces real browser TLS/HTTP2 handshakes for outgoing 4chan requests
# (picked up automatically by src/inc/chan_http.mjs via PATH). Pinned release + SHA-256 per arch;
# unsupported architectures skip it and the app falls back to plain curl with a random User-Agent.
ARG CURL_IMPERSONATE_VERSION=v2.2.3
ARG CURL_IMPERSONATE_SHA256_X86_64=288332a313e9edd884a1575c2627844fd9f3388fcefc62982b6b4eae12828357
ARG CURL_IMPERSONATE_SHA256_AARCH64=18000c51542fe63f0acc5cd3d89fb2217e35574f4c2911aec33e6774973a0809
ARG TARGETARCH
RUN set -eux; \
    case "${TARGETARCH:-$(uname -m)}" in \
      amd64|x86_64)  arch=x86_64;  sha="$CURL_IMPERSONATE_SHA256_X86_64" ;; \
      arm64|aarch64) arch=aarch64; sha="$CURL_IMPERSONATE_SHA256_AARCH64" ;; \
      *) echo "curl-impersonate: no build for ${TARGETARCH:-$(uname -m)}, skipping"; exit 0 ;; \
    esac; \
    curl -fsSL -o /tmp/curl-impersonate.tgz \
      "https://github.com/lexiforest/curl-impersonate/releases/download/${CURL_IMPERSONATE_VERSION}/curl-impersonate-${CURL_IMPERSONATE_VERSION}.${arch}-linux-musl.tar.gz"; \
    echo "${sha}  /tmp/curl-impersonate.tgz" | sha256sum -c -; \
    mkdir -p /opt/curl-impersonate; \
    tar xzf /tmp/curl-impersonate.tgz -C /opt/curl-impersonate; \
    rm /tmp/curl-impersonate.tgz; \
    /opt/curl-impersonate/curl-impersonate --version | head -n 1
ENV PATH="/opt/curl-impersonate:${PATH}"

WORKDIR /opt/f0ckm
COPY . .

RUN npm i
RUN npm run copy-vendor
RUN npm run build

ENTRYPOINT ["npm", "run", "start"]
