use std::{env, fs, path::PathBuf, process::Command};

fn main() {
    for input in ["wasm/Cargo.toml", "wasm/Cargo.lock", "wasm/src"] {
        println!("cargo:rerun-if-changed={input}");
    }
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let target = out.join("wasm-target");
    let status = Command::new(env::var_os("CARGO").unwrap())
        .args([
            "build",
            "--locked",
            "--release",
            "--manifest-path",
            "wasm/Cargo.toml",
            "--target",
            "wasm32-unknown-unknown",
            "--target-dir",
        ])
        .arg(&target)
        .env_remove("CARGO_ENCODED_RUSTFLAGS")
        .env_remove("RUSTFLAGS")
        .status()
        .expect("start Rust WebAssembly build");
    assert!(status.success(), "Dashboard build failed. Install the Rust target with rustup target add wasm32-unknown-unknown");
    fs::copy(
        target.join("wasm32-unknown-unknown/release/auction_calculations.wasm"),
        out.join("auction.wasm"),
    )
    .unwrap();
}
