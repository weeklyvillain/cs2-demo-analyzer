//! Unit tests for the pieces that do not need a demo file. End-to-end
//! behaviour is covered by the parity scripts in `parity/`.

use crate::db;
use crate::equipment as eq;
use crate::hull;
use crate::model::*;
use crate::post;
use crate::source::demo_source;
use crate::util::{go_float, parse_flat_object, J};

#[test]
fn floats_are_formatted_like_go_json() {
    assert_eq!(go_float(0.0), "0");
    assert_eq!(go_float(100.0), "100");
    assert_eq!(go_float(10.8125), "10.8125");
    assert_eq!(go_float(0.5529999999999999), "0.5529999999999999");
    assert_eq!(go_float(78.9873417721519), "78.9873417721519");
    assert_eq!(go_float(-363.96875), "-363.96875");
    assert_eq!(go_float(1e-7), "1e-7");
    assert_eq!(go_float(1e21), "1e+21");
    assert_eq!(go_float(123456789012.0), "123456789012");
}

#[test]
fn json_objects_have_sorted_keys_and_escaped_strings() {
    let mut o = J::obj();
    o.insert("seconds".into(), J::F(6.1875));
    o.insert("endedBy".into(), J::S("MOVED".into()));
    o.insert("end_tick".into(), J::Int(84594));
    o.insert("name".into(), J::S("a<b>&c".into()));
    let text = J::O(o).encode();
    // Like Go, HTML-sensitive characters are written as unicode escapes.
    let name = format!("a{0}u003cb{0}u003e{0}u0026c", char::from(92u8));
    assert_eq!(
        text,
        format!(r#"{{"end_tick":84594,"endedBy":"MOVED","name":"{}","seconds":6.1875}}"#, name)
    );
    assert!(!text.contains('<'));
}

#[test]
fn metadata_survives_a_parse_and_encode_round_trip() {
    let text = r#"{"disconnect_time":1959.90625,"reason":2}"#;
    assert_eq!(J::O(parse_flat_object(text)).encode(), text);
    let text = r#"{"disconnect_time":12.5,"reason":null}"#;
    assert_eq!(J::O(parse_flat_object(text)).encode(), text);
}

#[test]
fn weapon_strings_map_to_equipment() {
    assert_eq!(eq::map_equipment("weapon_ak47"), eq::AK47);
    assert_eq!(eq::map_equipment("ak47"), eq::AK47);
    assert_eq!(eq::map_equipment("m4a1"), eq::M4A4);
    assert_eq!(eq::map_equipment("m4a1_silencer"), eq::M4A1);
    assert_eq!(eq::map_equipment("usp_silencer"), eq::USP);
    assert_eq!(eq::map_equipment("hkp2000"), eq::P2000);
    assert_eq!(eq::map_equipment("hegrenade"), eq::HE);
    assert_eq!(eq::map_equipment("smokegrenade"), eq::SMOKE);
    assert_eq!(eq::map_equipment("inferno"), eq::INCENDIARY);
    assert_eq!(eq::map_equipment("knife_karambit"), eq::KNIFE);
    assert_eq!(eq::map_equipment("bayonet"), eq::KNIFE);
    assert_eq!(eq::map_equipment("planted_c4"), eq::BOMB);
    assert_eq!(eq::map_equipment("world"), eq::WORLD);
    assert_eq!(eq::map_equipment(""), eq::UNKNOWN);
    assert_eq!(eq::map_equipment("something_new"), eq::UNKNOWN);
}

#[test]
fn equipment_names_and_classes() {
    assert_eq!(eq::name(eq::from_item_index(7)), "AK-47");
    assert_eq!(eq::name(eq::from_item_index(60)), "M4A1");
    assert_eq!(eq::name(eq::from_item_index(61)), "USP-S");
    assert_eq!(eq::name(eq::from_item_index(507)), "Knife");
    assert_eq!(eq::name(eq::from_item_index(9999)), "UNKNOWN");
    assert_eq!(eq::class(eq::AK47), eq::CLASS_RIFLE);
    assert_eq!(eq::class(eq::MP9), eq::CLASS_SMG);
    assert_eq!(eq::class(eq::NOVA), eq::CLASS_HEAVY);
    assert_eq!(eq::class(eq::HE), eq::CLASS_GRENADE);
    assert_eq!(eq::alternative(eq::M4A4), eq::M4A1);
    assert_eq!(eq::alternative(eq::AK47), eq::UNKNOWN);
}

#[test]
fn convex_hull_drops_interior_and_collinear_points() {
    let pts = vec![[0.0, 0.0], [4.0, 0.0], [4.0, 4.0], [0.0, 4.0], [2.0, 2.0], [2.0, 0.0]];
    let mut h = hull::convex_hull(pts);
    assert_eq!(h.len(), 4);
    hull::sort_clockwise(&mut h);
    // Clockwise around the centre, starting on the right-hand side.
    assert_eq!(h, vec![[4.0, 4.0], [4.0, 0.0], [0.0, 0.0], [0.0, 4.0]]);
}

#[test]
fn small_point_sets_are_returned_as_they_are() {
    assert!(hull::convex_hull(vec![]).is_empty());
    assert_eq!(hull::convex_hull(vec![[1.0, 2.0], [1.0, 2.0]]), vec![[1.0, 2.0]]);
    assert_eq!(hull::convex_hull(vec![[3.0, 1.0], [1.0, 2.0]]).len(), 2);
}

#[test]
fn demo_source_is_detected_from_the_file_name() {
    assert_eq!(demo_source("", "12345_team-foo-team-bar_de_mirage.dem"), "faceit");
    assert_eq!(demo_source("", "2024-05-01_20-15-33_12_de_dust2_alpha_vs_beta"), "matchzy");
    assert_eq!(demo_source("", "123_teamA-teamB_de_dust2.dem"), "ebot");
    assert_eq!(demo_source("", "GBfmcvmPmfnK.dem"), "unknown");
    assert_eq!(demo_source("FACEIT.com register to play here", "x.dem"), "faceit");
    assert_eq!(demo_source("Valve CS2 EU West Server", "x.dem"), "valve");
}

fn pos(round: i32, tick: i32, steamid: u64, x: f64, y: f64, z: f64) -> Position {
    Position {
        round,
        tick,
        steamid,
        x,
        y,
        z,
        view_x: None,
        view_y: None,
        team: "T",
        health: Some(100),
        armor: None,
        weapon: None,
    }
}

fn match_with(positions: Vec<Position>, round_end: i32) -> MatchData {
    MatchData {
        tick_rate: 64.0,
        rounds: vec![Round {
            index: 0,
            start: 0,
            freeze_end: Some(100),
            end: round_end,
            t_wins: 0,
            ct_wins: 0,
            winner: None,
        }],
        positions,
        ..Default::default()
    }
}

#[test]
fn duplicate_positions_keep_the_last_row() {
    let mut p = vec![pos(0, 8, 2, 0.0, 0.0, 0.0), pos(0, 4, 1, 1.0, 0.0, 0.0), pos(0, 4, 1, 9.0, 0.0, 0.0)];
    post::dedup_positions(&mut p);
    assert_eq!(p.len(), 2);
    assert_eq!((p[0].tick, p[0].x), (4, 9.0));
    assert_eq!(p[1].tick, 8);
}

#[test]
fn a_player_who_never_moves_is_afk_until_round_end() {
    let mut positions = Vec::new();
    for tick in (100..=1000).step_by(4) {
        positions.push(pos(0, tick, 1, 10.0, 10.0, 0.0));
        // Player 2 runs the whole time.
        positions.push(pos(0, tick, 2, tick as f64 * 4.0, 0.0, 0.0));
    }
    post::dedup_positions(&mut positions);
    let events = post::detect_afk(&match_with(positions, 1000));
    assert_eq!(events.len(), 1);
    let e = &events[0];
    assert_eq!((e.typ, e.start, e.end), ("AFK_STILLNESS", 100, Some(1000)));
    assert_eq!(e.actor.as_deref(), Some("1"));
    assert!(e.meta.as_deref().unwrap().contains(r#""endedBy":"ROUND_END""#));
}

#[test]
fn moving_after_the_grace_period_ends_the_afk_period() {
    let mut positions = Vec::new();
    for tick in (100..=1000).step_by(4) {
        let x = if tick < 600 { 0.0 } else { (tick - 600) as f64 * 4.0 };
        positions.push(pos(0, tick, 1, x, 0.0, 0.0));
    }
    let events = post::detect_afk(&match_with(positions, 1000));
    assert_eq!(events.len(), 1);
    assert_eq!((events[0].start, events[0].end), (100, Some(604)));
    assert!(events[0].meta.as_deref().unwrap().contains(r#""endedBy":"MOVED""#));
}

#[test]
fn moving_during_the_grace_period_is_not_afk() {
    let positions = (100..=1000).step_by(4).map(|t| pos(0, t, 1, t as f64 * 4.0, 0.0, 0.0)).collect();
    assert!(post::detect_afk(&match_with(positions, 1000)).is_empty());
}

#[test]
fn standing_on_a_teammate_is_a_body_block() {
    let mut positions = Vec::new();
    for tick in (0..400).step_by(4) {
        positions.push(pos(0, tick, 1, 0.0, 0.0, 64.0));
        positions.push(pos(0, tick, 2, 3.0, 4.0, 0.0));
    }
    post::dedup_positions(&mut positions);
    let events = post::detect_body_block(&match_with(positions, 400));
    assert_eq!(events.len(), 1);
    let e = &events[0];
    assert_eq!(e.typ, "BODY_BLOCK");
    assert_eq!((e.actor.as_deref(), e.victim.as_deref()), (Some("1"), Some("2")));
    assert_eq!((e.start, e.end), (0, Some(396)));
    assert!(e.meta.as_deref().unwrap().contains(r#""stacked_ticks":100"#));
    assert!(e.meta.as_deref().unwrap().contains(r#""min_xy_distance":5"#));
}

#[test]
fn short_stacks_and_opponents_are_ignored() {
    let mut positions = Vec::new();
    for tick in (0..40).step_by(4) {
        positions.push(pos(0, tick, 1, 0.0, 0.0, 64.0));
        positions.push(pos(0, tick, 2, 0.0, 0.0, 0.0));
    }
    assert!(post::detect_body_block(&match_with(positions.clone(), 400)).is_empty());
    let mut long = Vec::new();
    for tick in (0..400).step_by(4) {
        long.push(pos(0, tick, 1, 0.0, 0.0, 64.0));
        let mut other = pos(0, tick, 2, 0.0, 0.0, 0.0);
        other.team = "CT";
        long.push(other);
    }
    assert!(post::detect_body_block(&match_with(long, 400)).is_empty());
}

fn event(typ: &'static str, actor: &str, meta: &str) -> Event {
    Event {
        typ,
        round: 0,
        start: 0,
        end: None,
        actor: Some(actor.into()),
        victim: None,
        severity: 1.0,
        confidence: 1.0,
        meta: Some(meta.into()),
    }
}

#[test]
fn scores_aggregate_events_per_player() {
    let events = vec![
        event("TEAM_KILL", "1", "{}"),
        event("TEAM_DAMAGE", "1", r#"{"total_damage":34}"#),
        event("AFK_STILLNESS", "2", r#"{"seconds":6.1875}"#),
        event("KILL", "3", "{}"),
    ];
    let scores = post::compute_scores(&events);
    assert_eq!(scores.len(), 3);
    let one = scores.iter().find(|s| s.steamid == "1").unwrap();
    assert_eq!((one.team_kills, one.team_damage), (1, 34.0));
    assert!((one.grief_score - 8.302).abs() < 1e-3);
    let two = scores.iter().find(|s| s.steamid == "2").unwrap();
    assert!((two.grief_score - 1.54141).abs() < 1e-4);
    assert_eq!(scores.iter().find(|s| s.steamid == "3").unwrap().grief_score, 0.0);
}

#[test]
fn database_round_trip() {
    let path = std::env::temp_dir().join(format!("cs2-extractor-test-{}.db", std::process::id()));
    let path_str = path.to_string_lossy().to_string();
    let _ = std::fs::remove_file(&path);

    let writer = db::Writer::start(&path_str, "m1");
    let sink = writer.sender();
    sink.send(db::Msg::Positions(vec![pos(0, 4, 7, 1.0, 2.0, 3.0), pos(0, 4, 7, 5.0, 2.0, 3.0)]))
        .unwrap();
    sink.send(db::Msg::Grenades(vec![GrenadePos {
        round: 0,
        tick: 4,
        projectile: 1,
        name: "flashbang",
        x: 1.0,
        y: 1.0,
        z: 1.0,
        thrower: Thrower::default(),
    }]))
    .unwrap();
    drop(sink);
    let data = MatchData {
        map: "de_test".into(),
        tick_rate: 64.0,
        source: "unknown".into(),
        build_num: 14000,
        players: vec![PlayerData { steamid: "7".into(), name: "p".into(), ..Default::default() }],
        events: vec![event("KILL", "7", "{}")],
        ..Default::default()
    };
    let scores = post::compute_scores(&data.events);
    writer
        .finish(db::Final { data, scores, demo_path: "x.dem".into(), created_at: "now".into() })
        .unwrap();

    let conn = rusqlite::Connection::open(&path).unwrap();
    let count = |table: &str| -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {}", table), [], |r| r.get(0)).unwrap()
    };
    // The second position replaces the first: same round, tick and player.
    assert_eq!(count("player_positions"), 1);
    let x: f64 = conn.query_row("SELECT x FROM player_positions", [], |r| r.get(0)).unwrap();
    assert_eq!(x, 5.0);
    assert_eq!(count("grenade_positions"), 1);
    assert_eq!(count("players"), 1);
    assert_eq!(count("events"), 1);
    assert_eq!(count("player_scores"), 1);
    let (map, source): (String, String) =
        conn.query_row("SELECT map, source FROM matches WHERE id = 'm1'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!((map.as_str(), source.as_str()), ("de_test", "unknown"));
    let build: String =
        conn.query_row("SELECT value FROM meta WHERE key = 'build_num'", [], |r| r.get(0)).unwrap();
    assert_eq!(build, "14000");
    drop(conn);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn an_aborted_run_leaves_no_database_behind() {
    let path = std::env::temp_dir().join(format!("cs2-extractor-abort-{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let writer = db::Writer::start(&path.to_string_lossy(), "m1");
    writer.sender().send(db::Msg::Positions(vec![pos(0, 4, 7, 1.0, 2.0, 3.0)])).unwrap();
    writer.abort();
    assert!(!path.exists());
}
