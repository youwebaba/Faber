#[path = "../src/gguf.rs"]
mod gguf;

use std::{
    env, fs::File, io::{self, Read, Seek, SeekFrom},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

struct CountedFile {
    file: File,
    reads: u64,
    seeks: u64,
    bytes: u64,
}

impl Read for CountedFile {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let count = self.file.read(buffer)?;
        self.reads += 1;
        self.bytes += count as u64;
        Ok(count)
    }
}

impl Seek for CountedFile {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.seeks += 1;
        self.file.seek(position)
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    for path in env::args_os().skip(1) {
        let file = File::open(path)?;
        let size = file.metadata()?.len();
        let mut source = CountedFile { file, reads: 0, seeks: 0, bytes: 0 };
        let started = Instant::now();
        let deadline = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as u64 + 5_000;
        let (metadata, remaining) = gguf::inspect(&mut source, size, 8 * 1024 * 1024, deadline);
        println!("{}", serde_json::json!({
            "fileBytes": size, "elapsedMs": started.elapsed().as_secs_f64() * 1000.0,
            "readCalls": source.reads, "seekCalls": source.seeks, "readBytes": source.bytes,
            "parsedBytes": metadata["bytesRead"], "remainingBudget": remaining,
            "complete": metadata["complete"], "warnings": metadata["warnings"]
        }));
    }
    Ok(())
}
