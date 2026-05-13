use std::env;

fn main() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        if let Ok(archive) = env::var("DEP_SOUNDTOUCH_ARCHIVE") {
            println!("cargo:rustc-link-arg=-Wl,-force_load,{}", archive);
        }
    }

    tauri_build::build()
}
