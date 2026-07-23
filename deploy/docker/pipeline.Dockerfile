FROM python:3.13-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN groupadd --gid 10001 synapse && useradd --uid 10001 --gid 10001 --create-home synapse
WORKDIR /opt/synapse
COPY pipeline/pyproject.toml pipeline/README.md ./pipeline/
COPY pipeline/src ./pipeline/src
RUN python -m pip install --upgrade pip && python -m pip install ./pipeline

USER 10001:10001
ENTRYPOINT ["synapse-pipeline"]
CMD ["--help"]
