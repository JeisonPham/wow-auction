FROM rust:1.93.1-trixie AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY web ./web
RUN cargo build --locked --release

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o 10001 -g 10001 /data
COPY --from=build /src/target/release/wow-auction-monitor /usr/local/bin/
ENV WOW_DATA_DIR=/data
USER 10001:10001
EXPOSE 8765
ENTRYPOINT ["wow-auction-monitor", "serve"]
