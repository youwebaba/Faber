#![forbid(unsafe_code)]

mod gguf;

use serde_json::json;
use std::{env, fs::File, io};

#[cfg(windows)]
fn input_file() -> io::Result<File> {
    use std::os::windows::io::AsHandle;
    Ok(File::from(io::stdin().as_handle().try_clone_to_owned()?))
}

#[cfg(unix)]
fn input_file() -> io::Result<File> {
    use std::os::fd::AsFd;
    Ok(File::from(io::stdin().as_fd().try_clone_to_owned()?))
}

fn run() -> Result<serde_json::Value, String> {
    let args: Vec<String> = env::args().collect();
    if args.len() != 4 || args[1] != "gguf-metadata" {
        return Err("Expected gguf-metadata with remaining byte budget and deadline".into());
    }
    let remaining: u64 = args[2].parse().map_err(|_| "Invalid GGUF byte budget")?;
    let deadline: u64 = args[3].parse().map_err(|_| "Invalid GGUF deadline")?;
    if remaining > gguf::MAX_SAFE_INTEGER || deadline > gguf::MAX_SAFE_INTEGER {
        return Err("Invalid GGUF inspection limits".into());
    }
    // The parent passes its validated, already-open model handle. Never reopen a path.
    let file = input_file().map_err(|error| error.to_string())?;
    let size = file.metadata().map_err(|error| error.to_string())?.len();
    let (metadata, remaining) = gguf::inspect(file, size, remaining, deadline);
    Ok(json!({ "metadata": metadata, "remaining": remaining }))
}

fn main() {
    let output = match run() {
        Ok(result) => json!({ "protocol": 1, "ok": true, "result": result }),
        Err(message) => json!({ "protocol": 1, "ok": false, "error": { "message": message } }),
    };
    println!("{output}");
}