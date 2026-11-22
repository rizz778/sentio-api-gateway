#!/bin/sh
# Render injects $PORT — that's the gateway's HTTP port.
# FastAPI gRPC runs internally on 50051 (not exposed publicly).
# FastAPI HTTP runs on 8000 (not exposed publicly).
#
# supervisord's `environment=` key REPLACES the process env, so we
# use nodenv_vars=true (supervisor 4+) OR simply exec the processes
# directly with environment inherited. We use a wrapper approach:
# supervisord inherits the full container env; programs use it directly.

export PORT="${PORT:-4000}"

exec /usr/bin/supervisord -c /etc/supervisor/conf.d/sentio.conf
