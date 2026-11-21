//! Parallel entity decoding for one demo.
//!
//! Decoding the bits of `SvcPacketEntities` messages is most of a parse, and it does
//! not depend on entity state: a field's decoder comes from the class serializer
//! alone. So worker threads split the demo at full packets and decode every entity
//! message of their chunk into a list of operations (`(field path, value)` pairs per
//! created/updated entity). The main thread runs the normal sequential parse and, at
//! each entity message, applies the pre-decoded operations instead of reading bits.
//! Observers see exactly the same callbacks in the same order.
//!
//! A worker that starts at a full packet learns which class each entity index has
//! from that packet's snapshot (the sequential parse ignores every full packet after
//! the first, so the snapshot itself is never applied). Every pre-decoded update
//! carries the class the worker assumed; the main thread checks it against the real
//! entity before applying, and decodes the message itself if anything disagrees or a
//! message is missing. A wrong split can therefore cost speed, never correctness.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::sync::{Arc, Condvar, Mutex};

use crate::entity::field::{FieldPath, FieldValue};
use crate::error::ParserError;
use crate::parser::demo::messages::DemoMessages;
use crate::parser::Parser;
use crate::proto::*;
use crate::reader::*;

/// One entity entry of a packet-entities message.
#[derive(Debug)]
pub(crate) enum EntityOp {
    Created { index: u32, class_id: i32, serial: u32, fields: (u32, u32) },
    Updated { index: u32, class_id: i32, fields: (u32, u32) },
    Deleted { index: u32 },
}

/// Pre-decoded contents of one `SvcPacketEntities` message.
#[derive(Debug, Default)]
pub(crate) struct PacketOps {
    pub(crate) ops: Vec<EntityOp>,
    /// Field updates for all ops, sliced by each op's `fields` range.
    pub(crate) fields: Vec<(FieldPath, FieldValue)>,
}

/// Key of an entity message: byte offset of its outer demo command, and the
/// ordinal of the packet-entities message inside it.
pub(crate) type MsgKey = (usize, u32);

type ChunkOps = VecDeque<(MsgKey, Option<PacketOps>)>;

/// The main thread's side: chunks arrive in order.
pub(crate) struct Predecoded {
    chunks: Vec<Receiver<ChunkOps>>,
    next_chunk: usize,
    current: ChunkOps,
    consumed: Arc<(Mutex<usize>, Condvar)>,
    stop: Arc<std::sync::atomic::AtomicBool>,
    /// Diagnostics (printed when CS2DA_PARALLEL_STATS is set): hits, misses, waiting time.
    pub(crate) stats: Stats,
}

#[derive(Default, Debug)]
pub(crate) struct Stats {
    pub(crate) hits: usize,
    pub(crate) misses: usize,
    pub(crate) mismatches: usize,
    pub(crate) wait: std::time::Duration,
    /// Applying ops, including the observer callbacks they trigger.
    pub(crate) apply: std::time::Duration,
    pub(crate) fields: usize,
    pub(crate) creates: usize,
}

/// Releases workers still waiting for their turn when dropped: at the end of a parse,
/// or while unwinding from a panic (a damaged demo), so the thread scope can finish.
pub(crate) struct Release {
    consumed: Arc<(Mutex<usize>, Condvar)>,
    stop: Arc<std::sync::atomic::AtomicBool>,
}

impl Drop for Release {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let (lock, cv) = &*self.consumed;
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        cv.notify_all();
    }
}

impl Predecoded {
    pub(crate) fn release_guard(&self) -> Release {
        Release { consumed: self.consumed.clone(), stop: self.stop.clone() }
    }
}

impl Predecoded {
    /// Ops for the message at `key`, if a worker decoded it. Keys are requested in
    /// file order; anything a worker produced for an earlier key is dropped.
    pub(crate) fn take(&mut self, key: MsgKey) -> Option<PacketOps> {
        loop {
            while let Some((k, _)) = self.current.front() {
                if *k < key {
                    self.current.pop_front();
                } else {
                    break;
                }
            }
            match self.current.front() {
                Some((k, _)) if *k == key => return self.current.pop_front().and_then(|(_, ops)| ops),
                Some(_) => return None,
                None => {}
            }
            // Current chunk used up: move to the next one (blocking until it's decoded).
            if self.next_chunk >= self.chunks.len() {
                return None;
            }
            let rx = &self.chunks[self.next_chunk];
            self.next_chunk += 1;
            let t = std::time::Instant::now();
            self.current = rx.recv().unwrap_or_default();
            self.stats.wait += t.elapsed();
            let (lock, cv) = &*self.consumed;
            *lock.lock().unwrap() = self.next_chunk;
            cv.notify_all();
            // A chunk whose messages all lie before `key` is skipped by the loop above.
            if let Some((k, _)) = self.current.back() {
                if *k < key {
                    self.current.clear();
                }
            }
        }
    }
}

/// Byte offsets of every `DemFullPacket` command (a cheap walk over command headers).
pub(crate) fn full_packet_offsets(data: &[u8]) -> Vec<usize> {
    fn varint(data: &[u8], pos: &mut usize) -> Option<u32> {
        let mut result = 0u32;
        for shift in (0..35).step_by(7) {
            let b = *data.get(*pos)?;
            *pos += 1;
            result |= ((b & 0x7f) as u32) << shift;
            if b < 0x80 {
                return Some(result);
            }
        }
        None
    }
    let mut out = Vec::new();
    let mut pos = 16; // "PBDEMS2\0" + two u32s
    while pos < data.len() {
        let start = pos;
        let (Some(cmd), Some(_tick), Some(size)) =
            (varint(data, &mut pos), varint(data, &mut pos), varint(data, &mut pos))
        else {
            break;
        };
        if (cmd as i32 & !(EDemoCommands::DemIsCompressed as i32)) == EDemoCommands::DemFullPacket as i32 {
            out.push(start);
        }
        pos += size as usize;
    }
    out
}

/// Chunk boundaries: `[start, end)` byte ranges, the first starting right after the
/// prologue (`None` = wherever the prologue ends), the rest at full packets.
pub(crate) fn plan_chunks(full_packets: &[usize], len: usize, min_bytes: usize) -> Vec<(Option<usize>, usize)> {
    let mut starts: Vec<usize> = Vec::new();
    for &fp in full_packets.iter().skip(1) {
        // Merge tiny chunks: each one pays for decoding a full snapshot first.
        if starts.last().map_or(fp >= min_bytes, |&last| fp - last >= min_bytes) {
            starts.push(fp);
        }
    }
    let mut chunks = Vec::with_capacity(starts.len() + 1);
    let mut prev: Option<usize> = None;
    for &s in &starts {
        chunks.push((prev, s));
        prev = Some(s);
    }
    chunks.push((prev, len));
    chunks
}

/// Stack for each decode worker.
const WORKER_STACK: usize = 16 * 1024 * 1024;

/// Start the workers; returns the receiving side for the main thread.
pub(crate) fn spawn<'scope, 'env: 'scope>(
    scope: &'scope std::thread::Scope<'scope, 'env>,
    data: &'env [u8],
    threads: usize,
) -> Option<Predecoded> {
    let fps = full_packet_offsets(data);
    if fps.len() < 2 || threads < 2 {
        return None;
    }
    // Small chunks (about one per full packet) keep the decoded-but-not-applied backlog small.
    let chunks = plan_chunks(&fps, data.len(), data.len() / 256);
    if chunks.len() < 2 {
        return None;
    }
    let mut senders: Vec<Option<SyncSender<ChunkOps>>> = Vec::new();
    let mut receivers = Vec::new();
    for _ in &chunks {
        let (tx, rx) = sync_channel(1);
        senders.push(Some(tx));
        receivers.push(rx);
    }
    let senders = Arc::new(Mutex::new(senders));
    let chunks = Arc::new(chunks);
    let next = Arc::new(AtomicUsize::new(0));
    let consumed = Arc::new((Mutex::new(0usize), Condvar::new()));
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    // Decode at most this many chunks ahead of the main thread. The main thread is the
    // slower side, so a larger window only buys memory use, not speed.
    let window = threads.min(2);

    for _ in 0..threads.min(chunks.len()) {
        let (chunks, next, senders, consumed, stop) =
            (chunks.clone(), next.clone(), senders.clone(), consumed.clone(), stop.clone());
        // Decoding recurses through nested field paths; the default 2 MiB thread stack
        // overflows in unoptimised (debug) builds, so give workers room.
        let spawned = std::thread::Builder::new()
            .name("demo-decode".into())
            .stack_size(WORKER_STACK)
            .spawn_scoped(scope, move || {
            let Ok(mut worker) = Worker::new(data) else { return };
            loop {
                let k = next.fetch_add(1, Ordering::SeqCst);
                if k >= chunks.len() {
                    break;
                }
                {
                    let (lock, cv) = &*consumed;
                    let mut done = lock.lock().unwrap_or_else(|e| e.into_inner());
                    while k >= *done + window && !stop.load(Ordering::SeqCst) {
                        done = cv.wait(done).unwrap_or_else(|e| e.into_inner());
                    }
                }
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                // A panic while decoding (damaged demo) leaves this chunk to the main
                // thread, which decodes it itself and reports the problem as usual.
                let ops = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| worker.decode_chunk(chunks[k])))
                    .ok()
                    .and_then(Result::ok)
                    .unwrap_or_default();
                let tx = senders.lock().unwrap()[k].take();
                if let Some(tx) = tx {
                    let _ = tx.send(ops);
                }
            }
        });
        spawned.expect("start demo decode worker");
    }
    Some(Predecoded { chunks: receivers, next_chunk: 0, current: VecDeque::new(), consumed, stop, stats: Stats::default() })
}

/// A parser used only for its classes, serializers and field reader.
struct Worker<'a> {
    parser: Parser<'a, SliceReader<'a>>,
    after_prologue: usize,
    /// Class id per entity index, as of the current position in this worker's chunk.
    classes: Vec<i32>,
}

impl<'a> Worker<'a> {
    fn new(data: &'a [u8]) -> Result<Self, ParserError> {
        let mut parser = Parser::new(data)?;
        parser.prologue()?;
        let after_prologue = parser.reader.source_buffer.len() - parser.reader.remaining_bytes();
        Ok(Worker { parser, after_prologue, classes: vec![-1; 1 << 14] })
    }

    fn decode_chunk(&mut self, (start, end): (Option<usize>, usize)) -> Result<ChunkOps, ParserError> {
        self.classes.iter_mut().for_each(|c| *c = -1);
        let mut out = ChunkOps::new();
        let start_offset = start.unwrap_or(self.after_prologue);
        self.parser.reader.seek(start_offset);
        let mut first_full_packet = start.is_none();
        loop {
            let offset = self.parser.reader.source_buffer.len() - self.parser.reader.remaining_bytes();
            if offset >= end {
                break;
            }
            let Some(message) = self.parser.reader.read_next_message()? else { break };
            let packet = match message.msg_type {
                EDemoCommands::DemPacket | EDemoCommands::DemSignonPacket => {
                    CDemoPacket::decode(message.buf.as_slice())?
                }
                EDemoCommands::DemFullPacket => {
                    let fp = CDemoFullPacket::decode(message.buf.as_slice())?;
                    let packet = fp.packet.unwrap_or_default();
                    if offset == start_offset && start.is_some() {
                        // This chunk's starting snapshot: learn the classes, emit nothing
                        // (the sequential parse ignores every full packet but the first).
                        self.scan_packet(&packet, offset, None)?;
                        continue;
                    }
                    if !first_full_packet {
                        // A later full packet inside this chunk: also ignored by the main parse.
                        continue;
                    }
                    first_full_packet = false;
                    packet
                }
                _ => continue,
            };
            self.scan_packet(&packet, offset, Some(&mut out))?;
        }
        Ok(out)
    }

    /// Walk a packet's inner messages; decode each packet-entities message, recording
    /// its ops in `out` (or only tracking classes when `out` is `None`).
    fn scan_packet(&mut self, packet: &CDemoPacket, offset: usize, mut out: Option<&mut ChunkOps>) -> Result<(), ParserError> {
        let mut reader = SliceReader::new(packet.data());
        let mut ordinal = 0u32;
        while reader.remaining_bytes() != 0 {
            let msg_type = reader.read_ubit_var() as i32;
            let size = reader.read_var_u32();
            let buf = reader.read_bytes(size);
            // Same dispatch order as `dem_packet`, so the same messages count as entities.
            #[cfg(feature = "cs2")]
            if ECstrike15UserMessages::try_from(msg_type).is_ok() || ECsgoGameEvents::try_from(msg_type).is_ok() {
                continue;
            }
            if SvcMessages::try_from(msg_type) != Ok(SvcMessages::SvcPacketEntities) {
                continue;
            }
            let key = (offset, ordinal);
            ordinal += 1;
            let msg = CSvcMsgPacketEntities::decode(buf.as_slice())?;
            let ops = self.decode_entities(&msg);
            if let Some(out) = out.as_deref_mut() {
                out.push_back((key, ops));
            }
        }
        Ok(())
    }

    /// `packet_entities` without touching entity state. `None` if an update refers to
    /// an entity this worker hasn't seen created (the main thread decodes it then).
    fn decode_entities(&mut self, msg: &CSvcMsgPacketEntities) -> Option<PacketOps> {
        let mut reader = SliceReader::new(msg.entity_data());
        let mut index = usize::MAX;
        let mut out = PacketOps::default();
        let ctx = &self.parser.context;
        for _ in 0..msg.updated_entries() {
            index = index.wrapping_add((reader.read_ubit_var() + 1) as usize);
            let cmd = reader.read_bits(2);
            if cmd == 1 {
                continue;
            }
            match cmd {
                0 => {
                    let class_id = *self.classes.get(index)?;
                    if class_id < 0 {
                        return None;
                    }
                    let class = ctx.classes.classes_vec.get(class_id as usize)?;
                    let from = out.fields.len() as u32;
                    self.parser.field_reader.decode_fields(&mut reader, &class.serializer, &mut out.fields);
                    out.ops.push(EntityOp::Updated {
                        index: index as u32,
                        class_id,
                        fields: (from, out.fields.len() as u32),
                    });
                }
                2 => {
                    let class_id = reader.read_bits_unchecked(ctx.classes.class_id_size) as i32;
                    let serial = reader.read_bits_unchecked(17);
                    let _ = reader.read_var_u32();
                    let class = ctx.classes.classes_vec.get(class_id as usize)?;
                    let from = out.fields.len() as u32;
                    self.parser.field_reader.decode_fields(&mut reader, &class.serializer, &mut out.fields);
                    *self.classes.get_mut(index)? = class_id;
                    out.ops.push(EntityOp::Created {
                        index: index as u32,
                        class_id,
                        serial,
                        fields: (from, out.fields.len() as u32),
                    });
                }
                _ => out.ops.push(EntityOp::Deleted { index: index as u32 }),
            }
        }
        Some(out)
    }
}

/// Main-thread check before applying: every update must target an entity of the class
/// the worker assumed, accounting for creates earlier in the same message.
pub(crate) fn classes_match(ops: &PacketOps, current: impl Fn(usize) -> i32) -> bool {
    let mut created: HashMap<u32, i32> = HashMap::new();
    for op in &ops.ops {
        match op {
            EntityOp::Created { index, class_id, .. } => {
                created.insert(*index, *class_id);
            }
            EntityOp::Updated { index, class_id, .. } => {
                let actual = created.get(index).copied().unwrap_or_else(|| current(*index as usize));
                if actual != *class_id {
                    return false;
                }
            }
            EntityOp::Deleted { .. } => {}
        }
    }
    true
}

impl<'a> Parser<'a, SliceReader<'a>> {
    /// Like `run_to_end`, with entity messages decoded on `threads` worker threads.
    /// Falls back to sequential decoding for anything the workers couldn't do.
    pub fn run_to_end_parallel(&mut self, threads: usize) -> Result<(), ParserError> {
        let data: &'a [u8] = self.reader.source_buffer;
        std::thread::scope(|scope| {
            self.predecoded = spawn(scope, data, threads);
            let _release = self.predecoded.as_ref().map(Predecoded::release_guard);
            let result = self.run_to_end_tracking_offsets();
            // Dropping it releases any worker still waiting, so the scope can end.
            if let Some(p) = self.predecoded.take() {
                if std::env::var_os("CS2DA_PARALLEL_STATS").is_some() {
                    eprintln!("parallel: {:?}", p.stats);
                }
            }
            result
        })
    }

    fn run_to_end_tracking_offsets(&mut self) -> Result<(), ParserError> {
        self.prologue()?;
        loop {
            self.outer_offset = self.reader.source_buffer.len() - self.reader.remaining_bytes();
            self.entities_ordinal = 0;
            let Some(message) = self.reader.read_next_message()? else { break };
            self.on_tick_start(message.tick)?;
            self.on_demo_command(message.msg_type, message.buf.as_slice())?;
        }
        self.on_tick_end()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_chunks_from_full_packets() {
        // Full packets at 100 (the first, part of chunk 0), 1000, 1100 (too close), 5000.
        let chunks = plan_chunks(&[100, 1000, 1100, 5000], 9000, 500);
        assert_eq!(chunks, vec![(None, 1000), (Some(1000), 5000), (Some(5000), 9000)]);
    }

    #[test]
    fn class_check_follows_creates_in_the_same_message() {
        let ops = PacketOps {
            ops: vec![
                EntityOp::Created { index: 5, class_id: 7, serial: 0, fields: (0, 0) },
                EntityOp::Updated { index: 5, class_id: 7, fields: (0, 0) },
                EntityOp::Updated { index: 9, class_id: 3, fields: (0, 0) },
            ],
            fields: vec![],
        };
        assert!(classes_match(&ops, |i| if i == 9 { 3 } else { -1 }));
        assert!(!classes_match(&ops, |i| if i == 9 { 4 } else { -1 }));
    }
}
