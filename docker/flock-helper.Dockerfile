# Reproducible build of src/signer/helpers/flock-linux-x64.
#
# Image: ubuntu 24.04 amd64, digest pinned below.
# Compiler: gcc-13 13.3.0-6ubuntu2~24.04.1 (Ubuntu GCC 13.3).
# Linker: binutils 2.42-4ubuntu2.10.
# Headers: libc6-dev 2.39-0ubuntu8.9, linux-libc-dev 6.8.0-147.147.
# Flags: scripts/build-flock-helper.sh
#   gcc-13 -Os -s -fno-ident -fno-record-gcc-switches
#   -fno-asynchronous-unwind-tables -ffile-prefix-map=/src=.
#   -Wl,--build-id=none
# The binary is dynamically linked against glibc. The recorded symbol
# versions are GLIBC_2.2.5 and GLIBC_2.34, so it runs on glibc 2.41.
# A static link is not used: it exceeds the published tarball limit.
#
# CI rebuilds this image and fails when the sha256 differs from
# LINUX_HELPER_SHA256 in src/signer/flock.ts or from the committed binary.
FROM ubuntu:24.04@sha256:f610ab94648195aa356059f5b41d6085c9d4d903c072430cdd1af7bdb646106b

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      gcc-13=13.3.0-6ubuntu2~24.04.1 \
      cpp-13=13.3.0-6ubuntu2~24.04.1 \
      gcc-13-base=13.3.0-6ubuntu2~24.04.1 \
      libgcc-13-dev=13.3.0-6ubuntu2~24.04.1 \
      binutils=2.42-4ubuntu2.10 \
      binutils-x86-64-linux-gnu=2.42-4ubuntu2.10 \
      libc6=2.39-0ubuntu8.9 \
      libc6-dev=2.39-0ubuntu8.9 \
      libc-dev-bin=2.39-0ubuntu8.9 \
      libcrypt-dev=1:4.4.36-4build1 \
      linux-libc-dev=6.8.0-147.147 \
 && rm -rf /var/lib/apt/lists/*

COPY scripts/build-flock-helper.sh /usr/local/bin/build-flock-helper.sh
COPY src/signer/helpers/flock-helper.c /src/flock-helper.c
RUN chmod 0755 /usr/local/bin/build-flock-helper.sh \
 && /usr/local/bin/build-flock-helper.sh /src/flock-helper.c /flock-linux-x64 \
 && chmod 0755 /flock-linux-x64
