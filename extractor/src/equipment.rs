//! Weapon / equipment identification, mirroring demoinfocs-golang's tables so
//! weapon names in the output stay identical to the old Go parser.

pub type Eq = i32;

pub const UNKNOWN: Eq = 0;
pub const P2000: Eq = 1;
pub const GLOCK: Eq = 2;
pub const P250: Eq = 3;
pub const DEAGLE: Eq = 4;
pub const FIVE_SEVEN: Eq = 5;
pub const DUAL_BERETTAS: Eq = 6;
pub const TEC9: Eq = 7;
pub const CZ: Eq = 8;
pub const USP: Eq = 9;
pub const REVOLVER: Eq = 10;
pub const MP7: Eq = 101;
pub const MP9: Eq = 102;
pub const BIZON: Eq = 103;
pub const MAC10: Eq = 104;
pub const UMP: Eq = 105;
pub const P90: Eq = 106;
pub const MP5: Eq = 107;
pub const SAWED_OFF: Eq = 201;
pub const NOVA: Eq = 202;
pub const MAG7: Eq = 203;
pub const XM1014: Eq = 204;
pub const M249: Eq = 205;
pub const NEGEV: Eq = 206;
pub const GALIL: Eq = 301;
pub const FAMAS: Eq = 302;
pub const AK47: Eq = 303;
pub const M4A4: Eq = 304;
pub const M4A1: Eq = 305;
pub const SSG08: Eq = 306;
pub const SG553: Eq = 307;
pub const AUG: Eq = 308;
pub const AWP: Eq = 309;
pub const SCAR20: Eq = 310;
pub const G3SG1: Eq = 311;
pub const ZEUS: Eq = 401;
pub const KEVLAR: Eq = 402;
pub const HELMET: Eq = 403;
pub const BOMB: Eq = 404;
pub const KNIFE: Eq = 405;
pub const DEFUSE_KIT: Eq = 406;
pub const WORLD: Eq = 407;
pub const ZONE_REPULSOR: Eq = 408;
pub const SHIELD: Eq = 409;
pub const HEAVY_ASSAULT_SUIT: Eq = 410;
pub const NIGHT_VISION: Eq = 411;
pub const HEALTH_SHOT: Eq = 412;
pub const TA_GRENADE: Eq = 413;
pub const FISTS: Eq = 414;
pub const BREACH_CHARGE: Eq = 415;
pub const TABLET: Eq = 416;
pub const AXE: Eq = 417;
pub const HAMMER: Eq = 418;
pub const WRENCH: Eq = 419;
pub const SNOWBALL: Eq = 420;
pub const BUMP_MINE: Eq = 421;
pub const DECOY: Eq = 501;
pub const MOLOTOV: Eq = 502;
pub const INCENDIARY: Eq = 503;
pub const FLASH: Eq = 504;
pub const SMOKE: Eq = 505;
pub const HE: Eq = 506;

pub const CLASS_SMG: i32 = 2;
pub const CLASS_HEAVY: i32 = 3;
pub const CLASS_RIFLE: i32 = 4;
pub const CLASS_GRENADE: i32 = 6;

pub fn class(e: Eq) -> i32 {
    (e + 99) / 100
}

/// Display name (`EquipmentType.String()`); empty for types without a name.
pub fn name(e: Eq) -> &'static str {
    match e {
        AK47 => "AK-47",
        AUG => "AUG",
        AWP => "AWP",
        BIZON => "PP-Bizon",
        BOMB => "C4",
        DEAGLE => "Desert Eagle",
        DECOY => "Decoy Grenade",
        DUAL_BERETTAS => "Dual Berettas",
        FAMAS => "FAMAS",
        FIVE_SEVEN => "Five-SeveN",
        FLASH => "Flashbang",
        G3SG1 => "G3SG1",
        GALIL => "Galil AR",
        GLOCK => "Glock-18",
        HE => "HE Grenade",
        P2000 => "P2000",
        INCENDIARY => "Incendiary Grenade",
        M249 => "M249",
        M4A4 => "M4A4",
        MAC10 => "MAC-10",
        MAG7 => "MAG-7",
        MOLOTOV => "Molotov",
        MP7 => "MP7",
        MP5 => "MP5-SD",
        MP9 => "MP9",
        NEGEV => "Negev",
        NOVA => "Nova",
        P250 => "P250",
        P90 => "P90",
        SAWED_OFF => "Sawed-Off",
        SCAR20 => "SCAR-20",
        SG553 => "SG 553",
        SMOKE => "Smoke Grenade",
        SSG08 => "SSG 08",
        ZEUS => "Zeus x27",
        TEC9 => "Tec-9",
        UMP => "UMP-45",
        XM1014 => "XM1014",
        M4A1 => "M4A1",
        CZ => "CZ75 Auto",
        USP => "USP-S",
        WORLD => "World",
        REVOLVER => "R8 Revolver",
        KEVLAR => "Kevlar Vest",
        HELMET => "Kevlar + Helmet",
        DEFUSE_KIT => "Defuse Kit",
        KNIFE => "Knife",
        UNKNOWN => "UNKNOWN",
        _ => "",
    }
}

pub fn alternative(e: Eq) -> Eq {
    match e {
        P2000 => USP,
        P250 | FIVE_SEVEN | TEC9 => CZ,
        DEAGLE => REVOLVER,
        MP7 => MP5,
        M4A4 => M4A1,
        _ => UNKNOWN,
    }
}

const NAME_TABLE: &[(&str, Eq)] = &[
    ("ak47", AK47),
    ("aug", AUG),
    ("awp", AWP),
    ("bizon", BIZON),
    ("c4", BOMB),
    ("planted_c4", BOMB),
    ("deagle", DEAGLE),
    ("decoy", DECOY),
    ("decoygrenade", DECOY),
    ("decoyprojectile", DECOY),
    ("decoy_projectile", DECOY),
    ("elite", DUAL_BERETTAS),
    ("famas", FAMAS),
    ("fiveseven", FIVE_SEVEN),
    ("flashbang", FLASH),
    ("g3sg1", G3SG1),
    ("galil", GALIL),
    ("galilar", GALIL),
    ("glock", GLOCK),
    ("hegrenade", HE),
    ("hkp2000", P2000),
    ("incgrenade", INCENDIARY),
    ("incendiarygrenade", INCENDIARY),
    ("inferno", INCENDIARY),
    ("m249", M249),
    ("m4a1", M4A4),
    ("mac10", MAC10),
    ("mag7", MAG7),
    ("molotov", MOLOTOV),
    ("molotovgrenade", MOLOTOV),
    ("molotovprojectile", MOLOTOV),
    ("molotov_projectile", MOLOTOV),
    ("mp7", MP7),
    ("mp5sd", MP5),
    ("mp9", MP9),
    ("negev", NEGEV),
    ("nova", NOVA),
    ("p250", P250),
    ("p90", P90),
    ("sawedoff", SAWED_OFF),
    ("scar20", SCAR20),
    ("sg556", SG553),
    ("smokegrenade", SMOKE),
    ("smokegrenadeprojectile", SMOKE),
    ("smokegrenade_projectile", SMOKE),
    ("ssg08", SSG08),
    ("taser", ZEUS),
    ("tec9", TEC9),
    ("ump45", UMP),
    ("xm1014", XM1014),
    ("m4a1_silencer", M4A1),
    ("m4a1_silencer_off", M4A1),
    ("cz75a", CZ),
    ("usp", USP),
    ("usp_silencer", USP),
    ("usp_silencer_off", USP),
    ("world", WORLD),
    ("revolver", REVOLVER),
    ("vest", KEVLAR),
    ("vesthelm", HELMET),
    ("defuser", DEFUSE_KIT),
    ("scar17", UNKNOWN),
    ("sensorgrenade", UNKNOWN),
    ("mp5navy", UNKNOWN),
    ("p228", UNKNOWN),
    ("scout", UNKNOWN),
    ("sg550", UNKNOWN),
    ("sg552", UNKNOWN),
    ("tmp", UNKNOWN),
    ("worldspawn", WORLD),
];

/// `common.MapEquipment`: maps a game-event weapon string to a type.
///
/// demoinfocs walks a Go map (random order) testing prefix/suffix; we resolve
/// an exact match first and otherwise the longest matching entry, which gives
/// the same answer for every real weapon string while being deterministic.
pub fn map_equipment(raw: &str) -> Eq {
    let n = raw.strip_prefix("weapon_").unwrap_or(raw);
    if n.contains("knife") || n.contains("bayonet") {
        return KNIFE;
    }
    if n.starts_with("m4a1_silencer") {
        return M4A1;
    }
    if n.starts_with("vesthelm") {
        return HELMET;
    }
    if let Some((_, e)) = NAME_TABLE.iter().find(|(k, _)| *k == n) {
        return *e;
    }
    let mut best: Option<(usize, Eq)> = None;
    for (k, e) in NAME_TABLE {
        if n.starts_with(k) || n.ends_with(k) {
            if best.map_or(true, |(l, _)| k.len() > l) {
                best = Some((k.len(), *e));
            }
        }
    }
    best.map_or(UNKNOWN, |(_, e)| e)
}

/// `common.EquipmentIndexMapping`: item definition index to type.
pub fn from_item_index(idx: u64) -> Eq {
    match idx {
        1 => DEAGLE,
        2 => DUAL_BERETTAS,
        3 => FIVE_SEVEN,
        4 => GLOCK,
        7 => AK47,
        8 => AUG,
        9 => AWP,
        10 => FAMAS,
        11 => G3SG1,
        13 => GALIL,
        14 => M249,
        16 => M4A4,
        17 => MAC10,
        19 => P90,
        20 => ZONE_REPULSOR,
        23 => MP5,
        24 => UMP,
        25 => XM1014,
        26 => BIZON,
        27 => MAG7,
        28 => NEGEV,
        29 => SAWED_OFF,
        30 => TEC9,
        31 => ZEUS,
        32 => P2000,
        33 => MP7,
        34 => MP9,
        35 => NOVA,
        36 => P250,
        37 => SHIELD,
        38 => SCAR20,
        39 => SG553,
        40 => SSG08,
        41 | 42 | 59 | 80 => KNIFE,
        43 => FLASH,
        44 => HE,
        45 => SMOKE,
        46 => MOLOTOV,
        47 => DECOY,
        48 => INCENDIARY,
        49 => BOMB,
        50 => KEVLAR,
        51 => HELMET,
        52 => HEAVY_ASSAULT_SUIT,
        54 => NIGHT_VISION,
        55 | 56 => DEFUSE_KIT,
        57 => HEALTH_SHOT,
        60 => M4A1,
        61 => USP,
        63 => CZ,
        64 => REVOLVER,
        68 => TA_GRENADE,
        69 | 74 => FISTS,
        70 => BREACH_CHARGE,
        72 => TABLET,
        75 => AXE,
        76 => HAMMER,
        78 => WRENCH,
        81 => BOMB,
        82 => DECOY,
        83 => HE,
        84 => SNOWBALL,
        85 => BUMP_MINE,
        500..=526 => KNIFE,
        _ => UNKNOWN,
    }
}
