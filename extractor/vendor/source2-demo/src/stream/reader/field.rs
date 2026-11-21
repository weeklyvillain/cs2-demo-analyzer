use crate::entity::field::{Decode, FieldPath, FieldState, Serializer};
use crate::reader::{BitsReader, SliceReader};
use crate::stream::field_path::{FieldOp, FieldPathCodec};

pub(crate) struct FieldReader {
    codec: FieldPathCodec,
    paths_buf: [FieldPath; 8192],
}

impl Default for FieldReader {
    fn default() -> Self {
        FieldReader {
            codec: FieldPathCodec::default(),
            paths_buf: [FieldPath::default(); 8192],
        }
    }
}

impl FieldReader {
    #[inline]
    pub(crate) fn read_fields(
        &mut self,
        reader: &mut SliceReader,
        serializer: &Serializer,
        state: &mut FieldState,
    ) {
        let mut i = 0;
        let mut fp = FieldPath::default();
        reader.refill();
        loop {
            let op = self.codec.read_op(reader);
            if let FieldOp::FieldPathEncodeFinish = op {
                break;
            }
            op.execute(reader, &mut fp);
            self.paths_buf[i] = fp;
            i += 1;
            reader.refill();
        }

        self.paths_buf[..i]
            .iter_mut()
            .for_each(|fp| state.set(fp, serializer.get_decoder(fp).decode(reader)))
    }

    /// Same bits as [`Self::read_fields`], but the decoded `(path, value)` pairs are
    /// appended to `out` instead of being written to an entity state. Applying them
    /// in order with `FieldState::set` gives exactly what `read_fields` would have
    /// produced: decoding depends only on the serializer, never on the state.
    pub(crate) fn decode_fields(
        &mut self,
        reader: &mut SliceReader,
        serializer: &Serializer,
        out: &mut Vec<(FieldPath, crate::entity::field::FieldValue)>,
    ) {
        let mut i = 0;
        let mut fp = FieldPath::default();
        reader.refill();
        loop {
            let op = self.codec.read_op(reader);
            if let FieldOp::FieldPathEncodeFinish = op {
                break;
            }
            op.execute(reader, &mut fp);
            self.paths_buf[i] = fp;
            i += 1;
            reader.refill();
        }

        out.extend(
            self.paths_buf[..i]
                .iter()
                .map(|fp| (*fp, serializer.get_decoder(fp).decode(reader))),
        );
    }
}
