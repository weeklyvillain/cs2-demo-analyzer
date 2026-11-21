//! One running app at a time (Electron `requestSingleInstanceLock` + `second-instance`):
//! a second launch hands its `.dem` arguments to the running app over a loopback socket
//! and exits; the running app parses them and comes to the front.
//!
//! The port is kept in `<data dir>/instance.port`. Nothing listens beyond 127.0.0.1.

use std::io::{BufRead, BufReader, Read as _, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, channel};
use std::time::Duration;

const HELLO: &str = "cs2da-open-v1";

fn port_file() -> PathBuf {
    cs2da_core::paths::data_dir().join("instance.port")
}

/// What a launch asks for: demos to parse, or (Explorer's "Play in CS2" item,
/// `--play-demo <file>`) a demo to play straight in CS2 without analysing it.
#[derive(Default)]
pub struct Launch {
    pub open: Vec<PathBuf>,
    pub play: Option<PathBuf>,
}

/// Electron's argv rule: `--play-demo <file>` wins; otherwise every `.dem` argument is opened.
pub fn launch_args() -> Launch {
    parse_args(std::env::args_os().skip(1).map(PathBuf::from).collect())
}

fn parse_args(args: Vec<PathBuf>) -> Launch {
    if let Some(i) = args.iter().position(|a| a.as_os_str() == "--play-demo") {
        return Launch { open: Vec::new(), play: args.get(i + 1).cloned() };
    }
    let open = args
        .into_iter()
        .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("dem")) && p.exists())
        .collect();
    Launch { open, play: None }
}

/// Try to hand this launch to an app that's already running. `true` = it took it, so exit.
pub fn forward_to_running(launch: &Launch) -> bool {
    let Some(port) = std::fs::read_to_string(port_file()).ok().and_then(|p| p.trim().parse::<u16>().ok()) else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&(Ipv4Addr::LOCALHOST, port).into(), Duration::from_millis(300)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
    let mut msg = format!("{HELLO}\n");
    if let Some(play) = &launch.play {
        msg.push_str(&format!("play:{}\n", play.to_string_lossy()));
    }
    for d in &launch.open {
        msg.push_str(&d.to_string_lossy());
        msg.push('\n');
    }
    msg.push('\n');
    if stream.write_all(msg.as_bytes()).is_err() {
        return false;
    }
    // The running app answers "ok"; anything else means the port belongs to something else.
    let mut reply = String::new();
    BufReader::new(stream).read_line(&mut reply).is_ok() && reply.trim() == "ok"
}

/// Become the running instance: listen for later launches. An empty launch just means
/// "come to the front".
pub fn listen() -> Option<Receiver<Launch>> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).ok()?;
    let port = listener.local_addr().ok()?.port();
    std::fs::create_dir_all(cs2da_core::paths::data_dir()).ok()?;
    std::fs::write(port_file(), port.to_string()).ok()?;
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let mut reader = BufReader::new(stream);
            let mut first = String::new();
            if reader.read_line(&mut first).is_err() || first.trim() != HELLO {
                continue;
            }
            let mut launch = Launch::default();
            for line in reader.by_ref().lines().map_while(Result::ok).take_while(|l| !l.is_empty()) {
                match line.strip_prefix("play:") {
                    Some(p) => launch.play = Some(PathBuf::from(p)),
                    None => launch.open.push(PathBuf::from(line)),
                }
            }
            let _ = reader.get_mut().write_all(b"ok\n");
            if tx.send(launch).is_err() {
                break;
            }
        }
    });
    Some(rx)
}

#[cfg(test)]
mod tests {
    use super::parse_args;
    use std::path::PathBuf;

    #[test]
    fn play_demo_flag_wins() {
        let l = parse_args(vec!["--play-demo".into(), "C:/x/a.dem".into()]);
        assert_eq!(l.play, Some(PathBuf::from("C:/x/a.dem")));
        assert!(l.open.is_empty());
    }
}
