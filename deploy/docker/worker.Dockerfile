FROM python:3.13-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN groupadd --gid 10001 synapse && useradd --uid 10001 --gid 10001 --create-home synapse
WORKDIR /opt/synapse
COPY intelligence/pyproject.toml intelligence/README.md ./intelligence/
RUN python -m pip install --upgrade pip && \
    python -m pip install \
      "ortools>=9.10,<10" \
      "psycopg[binary]>=3.2,<4" \
      "statsforecast>=2,<3"
COPY intelligence/src ./intelligence/src
RUN python -m pip install --no-deps ./intelligence

USER 10001:10001
CMD ["sh", "-c", "while true; do synapse-intelligence worker-once --worker-id ${WORKER_ID:-worker-01}; sleep ${WORKER_POLL_SECONDS:-30}; done"]
