# syntax=docker/dockerfile:1

# Python 3.14 on Debian, pinned by digest so every build starts from the same image.
FROM python:3.14-slim@sha256:22eafb370920ad8b429e0aec3fff433e0669968519f5d60469d83729c138b28b AS base
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --require-hashes --no-deps -r requirements.txt

# Browser libraries, fetched and checked against the SHA-256 digests in vendor.json.
FROM base AS vendor
WORKDIR /build
COPY vendor.json .
COPY scripts/fetch_vendor.py scripts/
RUN python scripts/fetch_vendor.py

# Tests: docker build --target test -t snild-test . && docker run --rm snild-test
FROM base AS test
COPY requirements-dev.txt .
RUN pip install --require-hashes --no-deps -r requirements-dev.txt
COPY pyproject.toml .
COPY snild/ snild/
COPY web/ web/
COPY tests/server/ tests/server/
COPY --from=vendor /build/web/vendor/ web/vendor/
# A hung test fails the run after ten minutes instead of blocking it.
CMD ["timeout", "600", "python", "-m", "pytest", "-q"]

# The image people run.
FROM base AS app
COPY LICENSE ./
COPY snild/ snild/
COPY web/ web/
COPY --from=vendor /build/web/vendor/ web/vendor/
RUN useradd --system --uid 10001 --home-dir /app --shell /usr/sbin/nologin snild \
    && mkdir -p /app/data && chown snild:snild /app/data \
    && printf '#!/bin/sh\nexec python -m snild.admin "$@"\n' > /usr/local/bin/snild-admin \
    && chmod 755 /usr/local/bin/snild-admin
USER snild
ENV SNILD_HOST=0.0.0.0 \
    SNILD_PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --start-interval=1s \
    CMD ["python", "-c", "import json, os, urllib.request; url = 'http://127.0.0.1:%s/api/v1/health' % (os.environ.get('SNILD_PORT') or '8080'); assert json.load(urllib.request.urlopen(url, timeout=2)) == {'status': 'ok'}"]
CMD ["python", "-m", "snild"]
