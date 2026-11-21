//! Data layer for the native CS2 Demo Analyzer.
//!
//! Reads the same files the Electron app writes (`%APPDATA%/cs-griefer-electron`),
//! so both apps can run side by side during the migration. Unlike the Electron
//! app, which loaded each whole `.sqlite` file into sql.js for every query,
//! this opens databases read-only through real SQLite and only reads the pages
//! a query touches.

pub mod cs2;
pub mod cs2_launch;
pub mod dbview;
pub mod details;
pub mod disconnect;
pub mod matches;
pub mod netcon;
pub mod parser;
pub mod releases;
pub mod paths;
pub mod replay;
pub mod settings;
pub mod stats;
pub mod updater;
pub mod voice;

pub use details::{ChatMessage, MatchEvent, RosterPlayer};
pub use matches::{MatchInfo, MatchSummary, MatchTotals, PlayerScore, Round};
