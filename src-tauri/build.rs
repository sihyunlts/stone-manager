fn main() {
  tauri_build::build();

  #[cfg(target_os = "macos")]
  {
    cc::Build::new()
      .file("src/macos_bridge.m")
      .flag("-fobjc-arc")
      .compile("macos_bridge");

    println!("cargo:rerun-if-changed=src/macos_bridge.m");
    println!("cargo:rustc-link-lib=framework=IOBluetooth");
    println!("cargo:rustc-link-lib=framework=Foundation");
  }
}
