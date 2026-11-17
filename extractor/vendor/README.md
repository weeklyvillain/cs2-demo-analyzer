# Vendored dependencies

## source2-demo 0.5.11

Copy of the crates.io release (https://crates.io/crates/source2-demo, MIT or
Apache-2.0) with one change in `src/entity/field/decoder.rs`: the
`qangle_precise` field encoding, used by `m_angEyeAngles` (the player view
direction), is decoded as `bits * 360 / 2^20 - 180` instead of
`bits * 360 / 2^20`, and encoded symmetrically.

Why it is patched here rather than corrected after the fact: a component that
is not transmitted decodes as `0.0`, and so does a transmitted raw value of
zero, which really means -180 degrees. Without the offset in the decoder the
two cases cannot be told apart, so a player looking exactly along -180 degrees
would be reported as looking along 0 degrees.

To update: replace this directory with the new release and reapply the change
(search for "Local patch"). Once an upstream release decodes the field with
the offset, point the dependency in `Cargo.toml` back at crates.io and delete
this directory; `eye_angles` in `src/util.rs` is the only code relying on it.
