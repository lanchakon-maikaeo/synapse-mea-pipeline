FROM python:3.13-slim@sha256:6771159cd4fa5d9bba1258caf0b82e6b73458c694d178ad97c5e925c2d0e1a91 AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/opt/synapse/api/src

RUN groupadd --gid 10001 synapse && useradd --uid 10001 --gid 10001 --create-home synapse
WORKDIR /opt/synapse
COPY api/requirements.lock ./api/requirements.lock
RUN python -m pip install \
      --require-hashes \
      --requirement ./api/requirements.lock
COPY --chown=10001:10001 api/src ./api/src

USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2)" || exit 1
CMD ["python", "-m", "uvicorn", "synapse_api.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-proxy-headers"]
