# CPU upstream is immutable and includes its locked Python packages and models.
ARG DOCLING_CPU_IMAGE=ghcr.io/docling-project/docling-serve-cpu@sha256:7b31b3c2efa17534dfcffb61665b71bbc959ad309b5b7ed82c3bbdcc63cc3d58
FROM ${DOCLING_CPU_IMAGE}
USER 0
RUN mkdir -p /opt/squabble && chown 1001:1000 /opt/squabble
COPY deploy/bundle_gateway.py /opt/squabble/bundle_gateway.py
COPY workers/documents/licenses /opt/squabble/licenses
USER 1001:1000
RUN python /opt/squabble/bundle_gateway.py manifest "$DOCLING_SERVE_ARTIFACTS_PATH" /opt/squabble/model-manifest.json \
    && python -m pip freeze > /opt/squabble/python-packages.txt
ENV BUNDLE_ENGINE=docling BUNDLE_PORT=5002 BUNDLE_TOKEN_FILE=/run/secrets/docling-token \
    DOCLING_DEVICE=cpu HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
    DOCLING_SERVE_ENABLE_REMOTE_SERVICES=false DOCLING_SERVE_ALLOW_EXTERNAL_PLUGINS=false \
    DOCLING_SERVE_ENABLE_MANAGEMENT_ENDPOINTS=false DOCLING_SERVE_ENABLE_UI=false \
    DOCLING_SERVE_MAX_FILE_SIZE=8388608 DOCLING_SERVE_MAX_NUM_PAGES=200 \
    DOCLING_SERVE_MAX_SOURCES_PER_REQUEST=1 DOCLING_SERVE_MAX_DOCUMENT_TIMEOUT=600 \
    DOCLING_SERVE_ENG_LOC_NUM_WORKERS=1 DOCLING_SERVE_SINGLE_USE_RESULTS=false \
    OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 DOCLING_NUM_THREADS=2
EXPOSE 5002
ENTRYPOINT ["python", "/opt/squabble/bundle_gateway.py"]
