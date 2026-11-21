fn main() {
    match std::env::args().nth(1).as_deref() {
        Some("--version") => println!("wow-auction-monitor {}", env!("CARGO_PKG_VERSION")),
        None | Some("serve") => {
            if let Err(e) = wow_auction_monitor::service::run() {
                eprintln!("{e}");
                std::process::exit(1)
            }
        }
        _ => {
            eprintln!("Usage: wow-auction-monitor [serve|--version]");
            std::process::exit(2)
        }
    }
}
