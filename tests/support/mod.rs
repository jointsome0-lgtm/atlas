use serde_json::Value;
use std::process::{Command, Output};
use tempfile::TempDir;

pub fn directory() -> TempDir {
    tempfile::Builder::new()
        .prefix("vera-example-atlas-")
        .tempdir()
        .unwrap()
}

pub fn command(directory: &TempDir, args: &[&str]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_atlas"));
    command
        .arg("--data-dir")
        .arg(directory.path())
        .arg("--json")
        .args(args);
    command
}

pub fn run(directory: &TempDir, args: &[&str]) -> Value {
    let output = command(directory, args).output().unwrap();
    success(output)
}

pub fn success(output: Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
