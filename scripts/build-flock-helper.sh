#!/bin/sh
# Rebuild src/signer/helpers/flock-linux-x64.
# The compiler, flags, and base image are pinned in docker/flock-helper.Dockerfile.
# A dynamic glibc binary is required. A static binary does not fit the package limit.
set -eu
src=${1:?source c file}
out=${2:?output path}
exec gcc-13 \
  -Os \
  -s \
  -fno-ident \
  -fno-record-gcc-switches \
  -fno-asynchronous-unwind-tables \
  -ffile-prefix-map=/src=. \
  -Wl,--build-id=none \
  -o "$out" \
  "$src"
