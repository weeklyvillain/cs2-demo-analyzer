//! Disconnect reasons, as shown by the Electron app (`src/utils/disconnectReason.ts`).

/// Human-readable text for a disconnect reason: a CS2 reason code or a free-form string.
pub fn format_reason(reason: &serde_json::Value) -> String {
    let code = match reason {
        serde_json::Value::Number(n) => n.as_i64(),
        serde_json::Value::String(s) => s.trim().parse::<i64>().ok(),
        _ => return "Disconnected".into(),
    };
    if let Some(code) = code {
        return reason_for_code(code).map_or_else(|| format!("Disconnect code {code}"), str::to_string);
    }
    let text = reason.as_str().unwrap_or("").trim();
    if text.is_empty() {
        return "Disconnected".into();
    }
    let lower = text.to_lowercase();
    let mapped = if lower.contains("kick") {
        "Kicked by server"
    } else if lower.contains("timeout") || lower.contains("timed out") {
        "Connection timeout"
    } else if lower.contains("ban") {
        "Banned"
    } else if lower.contains("disconnect by user") || lower.contains("user disconnect") {
        "Disconnected by user"
    } else if lower.contains("connection") && lower.contains("lost") {
        "Connection lost"
    } else if lower.contains("server") && lower.contains("full") {
        "Server full"
    } else if lower.contains("exiting") {
        "Shutting down game"
    } else {
        let mut c = text.chars();
        return c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default();
    };
    mapped.into()
}

// Generated from src/utils/disconnectReason.ts (ENetworkDisconnectionReason).
pub fn reason_for_code(code: i64) -> Option<&'static str> {
    Some(match code {
        0 => "Invalid",
        1 => "Shutdown",
        2 => "Disconnected by user",
        3 => "Disconnect by server",
        4 => "Connection lost",
        5 => "Overflow",
        6 => "Steam banned",
        7 => "Steam in use",
        8 => "Steam ticket",
        9 => "Steam logon",
        10 => "Steam auth cancelled",
        11 => "Steam auth already used",
        12 => "Steam auth invalid",
        13 => "Steam VAC ban state",
        14 => "Steam logged in elsewhere",
        15 => "Steam VAC check timed out",
        16 => "Steam dropped",
        17 => "Steam ownership",
        18 => "Server info overflow",
        19 => "Tick message overflow",
        20 => "String table message overflow",
        21 => "Delta entity message overflow",
        22 => "Temp entity message overflow",
        23 => "Sounds message overflow",
        24 => "Snapshot overflow",
        25 => "Error sending snapshot",
        26 => "Reliable overflow",
        27 => "Bad delta tick",
        28 => "No more splits",
        29 => "Unable to establish a connection with the gameserver.",
        30 => "Disconnected",
        31 => "Leaving split",
        32 => "Different class tables",
        33 => "Bad relay password",
        34 => "Bad spectator password",
        35 => "HLTV restricted",
        36 => "No spectators",
        37 => "HLTV unavailable",
        38 => "HLTV stop",
        39 => "Kicked",
        40 => "Ban added",
        41 => "Kick ban added",
        42 => "HLTV direct",
        43 => "Pure server client extra",
        44 => "Pure server mismatch",
        45 => "User command",
        46 => "Rejected by game",
        47 => "Message parse error",
        48 => "Invalid message error",
        49 => "Bad server password",
        50 => "Direct connect reservation",
        51 => "Connection failure",
        52 => "No peer group handlers",
        53 => "Reconnection",
        54 => "Loop shutdown",
        55 => "Loop deactivated.",
        56 => "Host endgame",
        57 => "Loop level load activate",
        58 => "Create server failed",
        59 => "Shutting down game",
        60 => "Request hoststate idle",
        61 => "Request hoststate HLTV relay",
        62 => "Client consistency fail",
        63 => "Client unable to CRC map",
        64 => "Client no map",
        65 => "Client different map",
        66 => "Server requires Steam",
        67 => "Steam deny misc",
        68 => "Steam deny bad anti-cheat",
        69 => "Server shutdown",
        71 => "Replay incompatible",
        72 => "Connect request timed out",
        73 => "Server incompatible",
        74 => "Local problem many relays",
        75 => "Local problem hosted server primary relay",
        76 => "Local problem network config",
        77 => "Local problem other",
        79 => "Remote timeout",
        80 => "Remote timeout connecting",
        81 => "Remote other",
        82 => "Remote bad crypt",
        83 => "Remote cert not trusted",
        84 => "Unusual",
        85 => "Internal error",
        128 => "Reject bad challenge",
        129 => "Reject no lobby",
        130 => "Reject background map",
        131 => "Reject single player",
        132 => "Reject hidden game",
        133 => "Reject LAN restrict",
        134 => "Reject bad password",
        135 => "Reject server full",
        136 => "Reject invalid reservation",
        137 => "Reject failed channel",
        138 => "Reject connect from lobby",
        139 => "Reject reserved for lobby",
        140 => "Reject invalid key length",
        141 => "Reject old protocol",
        142 => "Reject new protocol",
        143 => "Reject invalid connection",
        144 => "Reject invalid cert length",
        145 => "Reject invalid Steam cert length",
        146 => "Reject Steam",
        147 => "Reject server auth disabled",
        148 => "Reject server CD key auth invalid",
        149 => "Reject banned",
        150 => "Kicked team killing",
        151 => "Kicked TK start",
        152 => "Kicked untrusted account",
        153 => "Kicked convicted account",
        154 => "Kicked competitive cooldown",
        155 => "Kicked team hurting",
        156 => "Kicked hostage killing",
        157 => "Kicked voted off",
        158 => "Kicked idle",
        159 => "Kicked suicide",
        160 => "Kicked no Steam login",
        161 => "Kicked no Steam ticket",
        162 => "Kicked input automation",
        163 => "Kicked VACNet abnormal behavior",
        164 => "Kicked insecure client",
        _ => return None,
    })
}
