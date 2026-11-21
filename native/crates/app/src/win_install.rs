//! Windows integration the installer relies on: the app's AppUserModelID and the
//! Start menu / desktop shortcuts that carry it.
//!
//! The Electron app ran as `com.csgriefer.app` (electron-builder `appId`), and its
//! shortcuts and users' taskbar pins carry that ID. Using the same ID keeps old pins
//! grouped with the new app's window. NSIS can't stamp the ID on a shortcut without a
//! plugin, so the installer calls this exe with `--install-shortcuts` / `--remove-shortcuts`.

use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result};
use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx, IPersistFile,
};
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
use windows::Win32::UI::Shell::{IShellLinkW, SetCurrentProcessExplicitAppUserModelID, ShellLink};
use windows::core::{HSTRING, Interface as _};

pub const APP_ID: &str = "com.csgriefer.app";
const SHORTCUT_NAME: &str = "CS2 Demo Analyzer.lnk";

/// Call before any window opens.
pub fn set_app_id() {
    unsafe {
        let _ = SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(APP_ID));
    }
}

fn start_menu_shortcut() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join(r"Microsoft\Windows\Start Menu\Programs").join(SHORTCUT_NAME))
}

fn desktop_shortcut() -> Option<PathBuf> {
    dirs::desktop_dir().map(|d| d.join(SHORTCUT_NAME))
}

fn create_shortcut(lnk: &Path, target: &Path) -> Result<()> {
    unsafe {
        // S_FALSE (already initialised on this thread) is fine.
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        link.SetPath(&HSTRING::from(target.as_os_str()))?;
        if let Some(dir) = target.parent() {
            link.SetWorkingDirectory(&HSTRING::from(dir.as_os_str()))?;
        }
        link.SetDescription(&HSTRING::from("CS2 Demo Analyzer"))?;
        link.SetIconLocation(&HSTRING::from(target.as_os_str()), 0)?;
        let store: IPropertyStore = link.cast()?;
        store.SetValue(&PKEY_AppUserModel_ID, &PROPVARIANT::from(APP_ID))?;
        store.Commit()?;
        let file: IPersistFile = link.cast()?;
        if let Some(dir) = lnk.parent() {
            std::fs::create_dir_all(dir)?;
        }
        file.Save(&HSTRING::from(lnk.as_os_str()), true)?;
    }
    Ok(())
}

/// `--install-shortcuts [--desktop]`: Start menu shortcut, and the desktop one when asked
/// (the installer passes `--desktop` on fresh installs and when one existed before).
pub fn install_shortcuts(desktop: bool) -> Result<()> {
    let exe = std::env::current_exe()?;
    let start = start_menu_shortcut().context("no Start menu folder")?;
    create_shortcut(&start, &exe).context("Start menu shortcut")?;
    if desktop {
        let d = desktop_shortcut().context("no desktop folder")?;
        create_shortcut(&d, &exe).context("desktop shortcut")?;
    }
    Ok(())
}

/// `--remove-shortcuts` (uninstaller).
pub fn remove_shortcuts() {
    for p in [start_menu_shortcut(), desktop_shortcut()].into_iter().flatten() {
        let _ = std::fs::remove_file(p);
    }
}

/// Handle the installer's helper modes. Returns true when one ran (the process should exit).
pub fn run_installer_mode() -> bool {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--install-shortcuts") {
        if let Err(e) = install_shortcuts(args.iter().any(|a| a == "--desktop")) {
            eprintln!("install-shortcuts: {e:#}");
            std::process::exit(1);
        }
        return true;
    }
    if args.iter().any(|a| a == "--remove-shortcuts") {
        remove_shortcuts();
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::{APP_ID, create_shortcut};
    use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
    use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance, IPersistFile, STGM_READ};
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
    use windows::core::{HSTRING, Interface as _};

    #[test]
    fn shortcut_carries_app_id() {
        let dir = std::env::temp_dir().join(format!("cs2da-lnk-{}", std::process::id()));
        let lnk = dir.join("Test.lnk");
        let exe = std::env::current_exe().unwrap();
        create_shortcut(&lnk, &exe).unwrap();
        unsafe {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).unwrap();
            let file: IPersistFile = link.cast().unwrap();
            file.Load(&HSTRING::from(lnk.as_os_str()), STGM_READ).unwrap();
            let store: IPropertyStore = link.cast().unwrap();
            let v = store.GetValue(&PKEY_AppUserModel_ID).unwrap();
            assert_eq!(v.to_string(), APP_ID);
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
