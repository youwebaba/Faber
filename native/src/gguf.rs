use serde_json::{json, Value};
use std::{
    collections::HashSet,
    io::{Read, Seek, SeekFrom},
    time::{SystemTime, UNIX_EPOCH},
};

pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const LIMIT: &str = "GGUF metadata inspection limit reached; remaining fields are unknown";

struct Reader<R> {
    input: R,
    size: u64,
    offset: u64,
    remaining: u64,
    deadline: u64,
    bytes_read: u64,
}

impl<R: Read + Seek> Reader<R> {
    fn check(&self, length: u64) -> Result<(), String> {
        if length > MAX_SAFE_INTEGER || length > self.size.saturating_sub(self.offset) {
            return Err("Truncated or invalid GGUF metadata".into());
        }
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
        if length > self.remaining || now > u128::from(self.deadline) {
            return Err(LIMIT.into());
        }
        Ok(())
    }

    fn bytes<const N: usize>(&mut self) -> Result<[u8; N], String> {
        self.check(N as u64)?;
        let mut bytes = [0; N];
        self.input.read_exact(&mut bytes).map_err(|_| "Truncated GGUF metadata")?;
        self.advance(N as u64, true);
        Ok(bytes)
    }

    fn advance(&mut self, length: u64, read: bool) {
        self.offset += length;
        self.remaining -= length;
        if read {
            self.bytes_read += length;
        }
    }

    fn skip(&mut self, length: u64) -> Result<(), String> {
        self.check(length)?;
        self.input.seek(SeekFrom::Start(self.offset + length)).map_err(|error| error.to_string())?;
        self.advance(length, false);
        Ok(())
    }

    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.bytes()?))
    }

    fn u64(&mut self) -> Result<u64, String> {
        let value = u64::from_le_bytes(self.bytes()?);
        if value > MAX_SAFE_INTEGER {
            return Err("GGUF integer exceeds supported range".into());
        }
        Ok(value)
    }

    fn string(&mut self, keep: bool, max: u64) -> Result<Option<String>, String> {
        let length = self.u64()?;
        if !keep {
            self.skip(length)?;
            return Ok(None);
        }
        if length > max {
            return Err("GGUF metadata string exceeds inspection limit".into());
        }
        self.check(length)?;
        let mut bytes = vec![0; length as usize];
        self.input.read_exact(&mut bytes).map_err(|_| "Truncated GGUF metadata")?;
        self.advance(length, true);
        let text = String::from_utf8(bytes).map_err(|_| "The encoded data was not valid for encoding utf-8")?;
        // TextDecoder removes a leading UTF-8 BOM from every independently decoded string.
        Ok(Some(text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned()))
    }

    fn value(&mut self, kind: u32, keep: bool, depth: usize) -> Result<Value, String> {
        if kind == 8 {
            return Ok(self.string(keep, 512)?.map(Value::String).unwrap_or(Value::Null));
        }
        if kind == 9 {
            if depth > 2 {
                return Err("GGUF nested array exceeds inspection limit".into());
            }
            let subtype = self.u32()?;
            let count = self.u64()?;
            if count > 1_000_000 {
                return Err("GGUF array exceeds inspection limit".into());
            }
            if let Some(width) = width(subtype) {
                self.skip(width * count)?;
            } else {
                for _ in 0..count {
                    self.value(subtype, false, depth + 1)?;
                }
            }
            return Ok(Value::Null);
        }
        let width = width(kind).ok_or("Unsupported GGUF metadata type")?;
        if !keep {
            self.skip(width)?;
            return Ok(Value::Null);
        }
        Ok(match kind {
            0 | 7 => json!(u8::from_le_bytes(self.bytes()?)),
            1 => json!(i8::from_le_bytes(self.bytes()?)),
            2 => json!(u16::from_le_bytes(self.bytes()?)),
            3 => json!(i16::from_le_bytes(self.bytes()?)),
            4 => json!(self.u32()?),
            5 => json!(i32::from_le_bytes(self.bytes()?)),
            10 => json!(self.u64()?),
            11 => {
                let value = i64::from_le_bytes(self.bytes()?);
                if value < 0 || value as u64 > MAX_SAFE_INTEGER {
                    return Err("GGUF integer exceeds supported range".into());
                }
                json!(value)
            }
            6 => {
                self.bytes::<4>()?;
                Value::Null
            }
            12 => {
                self.bytes::<8>()?;
                Value::Null
            }
            _ => unreachable!(),
        })
    }

    fn parse(&mut self, result: &mut Value) -> Result<(), String> {
        self.input.seek(SeekFrom::Start(0)).map_err(|error| error.to_string())?;
        if &self.bytes::<4>()? != b"GGUF" {
            return Err("Invalid GGUF header".into());
        }
        if ![2, 3].contains(&self.u32()?) {
            return Err("Unsupported GGUF version or byte order".into());
        }
        let tensor_count = self.u64()?;
        let metadata_count = self.u64()?;
        if tensor_count > 100_000 || metadata_count > 10_000 {
            return Err("GGUF entry count exceeds inspection limit".into());
        }
        let mut keys = HashSet::new();
        for _ in 0..metadata_count {
            let key = self.string(true, 1024)?.unwrap();
            let kind = self.u32()?;
            if !keys.insert(key.clone()) {
                return Err("Duplicate GGUF metadata key".into());
            }
            let field = match key.as_str() {
                "general.architecture" => Some("architecture"),
                "general.file_type" => Some("fileType"),
                "split.count" => Some("splitCount"),
                "split.no" => Some("splitNo"),
                "split.tensors.count" => Some("splitTensors"),
                _ => None,
            };
            let value = self.value(kind, field.is_some(), 0)?;
            if let Some(field) = field {
                if field == "architecture" {
                    if value.as_str().is_some_and(|text| !text.is_empty() && text.len() <= 100
                        && text.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))) {
                        result[field] = value;
                    }
                } else if value.as_u64().is_some_and(|number| number <= MAX_SAFE_INTEGER) {
                    result[field] = value;
                }
            }
        }
        let mut names = HashSet::new();
        for _ in 0..tensor_count {
            let name = self.string(true, 64)?.unwrap();
            let dimensions = self.u32()?;
            if name.is_empty() || !names.insert(name.clone()) || !(1..=4).contains(&dimensions) {
                return Err("Invalid GGUF tensor descriptor".into());
            }
            let mut elements = 1_u64;
            for _ in 0..dimensions {
                let size = self.u64()?;
                if size == 0 {
                    return Err("Invalid GGUF tensor dimension".into());
                }
                elements = elements.checked_mul(size).filter(|value| *value <= MAX_SAFE_INTEGER)
                    .ok_or("GGUF tensor exceeds supported range")?;
            }
            self.u32()?;
            self.u64()?;
            result["tensors"].as_array_mut().unwrap().push(json!({ "name": name, "elements": elements }));
        }
        result["complete"] = Value::Bool(true);
        Ok(())
    }
}

fn width(kind: u32) -> Option<u64> {
    match kind {
        0 | 1 | 7 => Some(1),
        2 | 3 => Some(2),
        4 | 5 | 6 => Some(4),
        10 | 11 | 12 => Some(8),
        _ => None,
    }
}

pub fn inspect<R: Read + Seek>(input: R, size: u64, remaining: u64, deadline: u64) -> (Value, u64) {
    let mut reader = Reader { input, size, offset: 0, remaining, deadline, bytes_read: 0 };
    let mut result = json!({
        "architecture": null, "fileType": null, "splitCount": null, "splitNo": null,
        "splitTensors": null, "tensors": [], "complete": false, "bytesRead": 0, "warnings": [],
    });
    if let Err(message) = reader.parse(&mut result) {
        result["warnings"] = json!([message]);
        result["tensors"] = json!([]);
    }
    result["bytesRead"] = json!(reader.bytes_read);
    (result, reader.remaining)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn header() -> Vec<u8> {
        let mut bytes = b"GGUF".to_vec();
        bytes.extend(3_u32.to_le_bytes());
        bytes.extend(0_u64.to_le_bytes());
        bytes.extend(0_u64.to_le_bytes());
        bytes
    }

    #[test]
    fn bounded_reader_preserves_partial_budget_and_error_contract() {
        let bytes = header();
        let (result, remaining) = inspect(Cursor::new(&bytes), bytes.len() as u64, 16, MAX_SAFE_INTEGER);
        assert_eq!(result["complete"], false);
        assert_eq!(result["bytesRead"], 16);
        assert_eq!(result["warnings"], json!([LIMIT]));
        assert_eq!(remaining, 0);
    }

    #[test]
    fn inherited_file_position_does_not_change_metadata_result() {
        let bytes = header();
        let mut input = Cursor::new(&bytes);
        input.set_position(bytes.len() as u64);
        let (result, remaining) = inspect(input, bytes.len() as u64, 8192, MAX_SAFE_INTEGER);
        assert_eq!(result["complete"], true);
        assert_eq!(result["bytesRead"], 24);
        assert_eq!(remaining, 8192 - 24);
    }

    #[test]
    fn valid_header_does_not_read_payload() {
        let mut bytes = header();
        bytes.extend([0x7f; 4096]);
        let (result, remaining) = inspect(Cursor::new(&bytes), bytes.len() as u64, 8192, MAX_SAFE_INTEGER);
        assert_eq!(result["complete"], true);
        assert_eq!(result["bytesRead"], 24);
        assert_eq!(remaining, 8192 - 24);
    }
}