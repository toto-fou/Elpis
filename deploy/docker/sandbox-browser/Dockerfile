# SPDX-License-Identifier: MIT
# deploy/docker/sandbox-browser/Dockerfile — elpis/sandbox:1.8.0 : the 1.7.0 image plus what the browser in the sandbox needs (NSS tools for the relay CA); no Elpis code.
#
#  The 1.7.0 image already carries every runtime library of Chromium's headless
#  shell (GTK, NSS, GBM, X11…) and its fonts (Liberation, Noto, CJK, emoji).
#  The browser service, the Node runtime and the headless shell are bind-mounted
#  read-only by the host (packages/bac/src/montages.ts), never copied here.
#  Built on top of the base by deploy/docker/sandbox/build_offline.sh.

ARG BASE=elpis/sandbox:1.7.0
FROM ${BASE}

LABEL org.opencontainers.image.title="elpis/sandbox"
LABEL org.opencontainers.image.description="Per-account Docker sandbox for Elpis, with the browser runtime"
LABEL org.opencontainers.image.version="1.8.0"

ARG DEBIAN_FRONTEND=noninteractive

# certutil: the browser service imports the relay CA certificate into its own NSS database at start.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libnss3-tools \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*
