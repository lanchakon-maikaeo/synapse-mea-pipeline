FROM python:3.13-slim@sha256:6771159cd4fa5d9bba1258caf0b82e6b73458c694d178ad97c5e925c2d0e1a91 AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/opt/synapse/pipeline/src

RUN groupadd --gid 10001 synapse && useradd --uid 10001 --gid 10001 --create-home synapse
WORKDIR /opt/synapse
COPY pipeline/requirements.lock ./pipeline/requirements.lock
RUN python -m pip install \
      --require-hashes \
      --requirement ./pipeline/requirements.lock
COPY --chown=10001:10001 pipeline/src ./pipeline/src

USER 10001:10001
ENTRYPOINT ["python", "-m", "synapse_pipeline"]
CMD ["--help"]
