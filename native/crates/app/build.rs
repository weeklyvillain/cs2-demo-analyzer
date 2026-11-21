//! Embeds the app icon (resources/icon.ico, the same one the Electron installer uses) and
//! version info into the Windows exe. GPUI loads icon resource #1 for the window and
//! taskbar, which is the id `winresource` uses.

fn main() {
    #[cfg(windows)]
    {
        let icon = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../resources/icon.ico");
        println!("cargo:rerun-if-changed={}", icon.display());
        let mut res = winresource::WindowsResource::new();
        res.set_icon(&icon.to_string_lossy())
            .set("ProductName", "CS2 Demo Analyzer")
            .set("FileDescription", "CS2 Demo Analyzer")
            .set("OriginalFilename", "CS2 Demo Analyzer.exe");
        if let Err(e) = res.compile() {
            println!("cargo:warning=couldn't embed the app icon: {e}");
        }
    }
}
