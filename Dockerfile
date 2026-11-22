# ============================================================
# Sentio Combined Service: Node.js Gateway + Python FastAPI
# Both run in the same container so gRPC on localhost:50051 works.
# Render exposes $PORT (Gateway HTTP/WS), FastAPI gRPC stays internal.
# ============================================================

FROM python:3.10-slim-bookworm

# ── System packages ─────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    gnupg \
    build-essential \
    gcc \
    libgl1 \
    libglib2.0-0 \
    supervisor \
    git \
    && rm -rf /var/lib/apt/lists/*

# ── Node.js 20 LTS ──────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── FastAPI backend ──────────────────────────────────────────
WORKDIR /app/fastapi

# Clone only the fastapi backend repo (shallow clone for speed)
ARG FASTAPI_REPO=https://github.com/rizz778/sentio-fastapi-backend.git
RUN git clone --depth=1 ${FASTAPI_REPO} .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# ── Gateway ──────────────────────────────────────────────────
WORKDIR /app/gateway

# Copy gateway source
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# ── Supervisor config ────────────────────────────────────────
COPY supervisord.conf /etc/supervisor/conf.d/sentio.conf

# ── Startup script ───────────────────────────────────────────
COPY start.sh /start.sh
RUN chmod +x /start.sh

EXPOSE 4000

CMD ["/start.sh"]
