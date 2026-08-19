# One container, four processes, one performance.
# node base + SuperCollider from Debian. This is the only Dockerfile in your
# life: it packages the one native dependency (scsynth) and never changes.

FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      supercollider-server \
      supercollider-language \
      jackd2 \
      ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# conductor deps
COPY conductor/package.json conductor/
RUN cd conductor && npm install --omit=dev

# frontend build
COPY frontend/package.json frontend/
RUN cd frontend && npm install
COPY frontend frontend
RUN cd frontend && npm run build

# audio: synthdefs compiled into the image
COPY audio audio
ENV SC_SYNTHDEF_PATH=/app/synthdefs
ENV QTWEBENGINE_CHROMIUM_FLAGS="--no-sandbox --disable-gpu"
# No `|| true` here on purpose. An image whose synthdefs failed to compile
# produces a perfectly healthy, perfectly silent stream — the hardest failure
# to diagnose from the outside. Better to never ship it.
RUN bash /app/audio/compile-synthdefs.sh

COPY conductor/server.js conductor/

ENV PORT=8080
EXPOSE 8080
CMD ["bash", "/app/audio/start.sh"]
