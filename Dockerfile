FROM rust:1.93.1-trixie AS build
WORKDIR /src
RUN rustup target add wasm32-unknown-unknown
COPY Cargo.toml Cargo.lock build.rs ./
COPY wasm ./wasm
COPY src ./src
COPY web ./web
RUN cargo build --locked --release

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl python3 \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o 10001 -g 10001 /data
COPY --from=build /src/target/release/wow-auction-monitor /usr/local/bin/
COPY client/blizzard.py client/broker.py client/sync.py client/addon.py client/snapshot.py client/lua_data.py client/disenchant.py /opt/scanner/
ENV WOW_BLIZZARD_HELPER=/opt/scanner/blizzard.py
ENV WOW_BROKER_HELPER=/opt/scanner/broker.py
ENV WOW_DATA_DIR=/data
USER 10001:10001
EXPOSE 8765
ENTRYPOINT ["wow-auction-monitor", "serve"]
