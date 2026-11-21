#!/bin/sh
set -eu
game=/wow/_forever_
# A remote gaming PC can keep uploading until a local installation is mounted.
while [ ! -d "$game/Interface/AddOns" ]; do sleep 15; done
exec python3 /opt/scanner/sync.py sync --wow-dir "$game" --watch \
    --server http://127.0.0.1:8765 --region "${WOW_REGION:-Forever-US}" --market "${WOW_MARKET:-Normal-Alliance}"
