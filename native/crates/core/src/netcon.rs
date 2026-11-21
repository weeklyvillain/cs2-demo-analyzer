//! Sending console commands to a running CS2 through its `-netconport` socket
//! (Electron `CS2CommandSender`): one TCP connection on 127.0.0.1, commands written one
//! per line with Electron's pacing (longer waits after `playdemo` / `demo_gototick`).
//! Blocking; call off the UI thread.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::Duration;

use anyhow::{Context as _, Result};

/// Electron's default when `cs2_netconport` isn't set.
pub const DEFAULT_PORT: u16 = 2121;

/// The configured netcon port (`cs2_netconport` setting).
pub fn port() -> u16 {
    crate::settings::Settings::open()
        .ok()
        .and_then(|s| s.get_or("cs2_netconport", "2121").parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

fn addr(port: u16) -> SocketAddr {
    (Ipv4Addr::LOCALHOST, port).into()
}

/// How long to wait after sending `cmd` before the next one (Electron's delays).
fn delay_after(cmd: &str, default_ms: u64) -> Duration {
    Duration::from_millis(if cmd.starts_with("demo_gototick") {
        2000
    } else if cmd.starts_with("playdemo") {
        3000
    } else if cmd.starts_with("demo_pause") {
        300
    } else {
        default_ms
    })
}

/// Send `cmds` in order (Electron `sendBatch`, default 150 ms between commands).
/// `log` receives each line Electron would log (sent commands and console replies).
pub fn send_batch(port: u16, cmds: &[String], delay_ms: u64, mut log: impl FnMut(String)) -> Result<()> {
    let mut stream = TcpStream::connect_timeout(&addr(port), Duration::from_secs(10))
        .with_context(|| format!("Couldn't connect to CS2 on netconport {port}. Is CS2 running with -netconport {port}?"))?;
    log(format!("Connected to CS2 netconport on port {port}"));
    // Drain console output in the background so CS2 never blocks on a full socket.
    let mut reader = stream.try_clone()?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            let text = String::from_utf8_lossy(&buf[..n]).trim().to_string();
            if !text.is_empty() && tx.send(text).is_err() {
                break;
            }
        }
    });
    for (i, cmd) in cmds.iter().enumerate() {
        log(format!("Sending command {}/{}: {cmd}", i + 1, cmds.len()));
        stream.write_all(format!("{}\n", cmd.trim_end()).as_bytes())?;
        let wait = if i + 1 < cmds.len() { delay_after(cmd, delay_ms) } else { Duration::from_millis(500) };
        std::thread::sleep(wait);
        while let Ok(reply) = rx.try_recv() {
            log(format!("Response: {reply}"));
        }
    }
    let _ = stream.shutdown(std::net::Shutdown::Both);
    Ok(())
}

pub fn send(port: u16, cmd: &str) -> Result<()> {
    send_batch(port, &[cmd.to_string()], 150, |_| {})
}

/// Is CS2 listening on the netcon port? (Electron `testConnection`, 2 s timeout.)
pub fn is_reachable(port: u16) -> bool {
    TcpStream::connect_timeout(&addr(port), Duration::from_secs(2)).is_ok()
}

/// Send one command and return whatever CS2 prints within `response_ms`
/// (Electron `sendCS2CommandAndGetResponse`, used to poll `demo_goto`).
pub fn send_and_read(port: u16, cmd: &str, response_ms: u64) -> Result<String> {
    let mut stream = TcpStream::connect_timeout(&addr(port), Duration::from_secs(10))
        .with_context(|| format!("Couldn't connect to CS2 on netconport {port}"))?;
    stream.write_all(format!("{}\n", cmd.trim_end()).as_bytes())?;
    let deadline = std::time::Instant::now() + Duration::from_millis(response_ms);
    let mut out = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            break;
        }
        stream.set_read_timeout(Some(left))?;
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => out.extend_from_slice(&buf[..n]),
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => break,
            Err(e) => {
                if out.is_empty() {
                    return Err(e.into());
                }
                break;
            }
        }
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufRead;

    #[test]
    fn paces_like_electron() {
        assert_eq!(delay_after("playdemo x", 150), Duration::from_millis(3000));
        assert_eq!(delay_after("demo_gototick 100", 150), Duration::from_millis(2000));
        assert_eq!(delay_after("spec_player 3", 150), Duration::from_millis(150));
    }

    #[test]
    fn sends_one_command_per_line() {
        let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (s, _) = listener.accept().unwrap();
            std::io::BufReader::new(s).lines().map_while(Result::ok).collect::<Vec<_>>()
        });
        send_batch(port, &["echo a".into(), "echo b  ".into()], 1, |_| {}).unwrap();
        assert_eq!(server.join().unwrap(), vec!["echo a", "echo b"]);
    }
}
