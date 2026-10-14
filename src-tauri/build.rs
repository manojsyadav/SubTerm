fn main() {
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=icons/icon.ico");

    // Tauri bundler requires all bundle.resources to exist at config parse time.
    // When running `cargo check` or `cargo test` directly (e.g. in CI or local dev)
    // without running `tauri build`'s beforeBuildCommand, the rdp-helper binary
    // may not have been compiled yet. Create a placeholder if missing so
    // that `cargo check` and `cargo test` succeed.
    ensure_resource_placeholders();

    tauri_build::build()
}

fn ensure_resource_placeholders() {
    let rdp_dir = std::path::Path::new("rdp-helper/target/release");
    let _ = std::fs::create_dir_all(rdp_dir);
    for name in &["subterm-rdp-helper", "subterm-rdp-helper.exe"] {
        let p = rdp_dir.join(name);
        if !p.exists() {
            let _ = std::fs::write(&p, b"");
        }
    }
}
