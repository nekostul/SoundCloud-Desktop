pub const DISCORD_CLIENT_ID: &str = "1431978756687265872";

pub const DOMAIN_WHITELIST: &[&str] = &[
    "localhost",
    "127.0.0.1",
    "tauri.localhost",
    "scproxy.localhost",
    "ipc.localhost",
    "unpkg.com",
];

pub fn is_domain_whitelisted(host: &str) -> bool {
    DOMAIN_WHITELIST.iter().any(|&w| host == w)
}
