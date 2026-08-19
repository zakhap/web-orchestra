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
RUN mkdir -p /app/synthdefs \
    && (QT_QPA_PLATFORM=offscreen HOME=/tmp sclang /app/audio/synthdefs.scd \
        || echo "sclang build-time compile failed; start.sh will retry at runtime") \
    && echo "--- /app/synthdefs after compile ---" \
    && ls -la /app/synthdefs

COPY conductor/server.js conductor/

ENV PORT=8080
EXPOSE 8080
CMD ["bash", "/app/audio/start.sh"]
