mod support;

use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use support::{command, directory, run, success};

#[test]
fn lost_create_receipt_replays_and_used_ids_never_resurrect() {
    let data = directory();
    let args = [
        "add",
        "--id",
        "vera-retry",
        "--material",
        "Vera Example book",
        "--actor",
        "Vera Example",
    ];
    assert!(
        command(&data, &args)
            .stdout(Stdio::null())
            .status()
            .unwrap()
            .success()
    );
    let before = run(&data, &["get", "--id", "vera-retry"]);
    let replay = run(&data, &args);
    assert_eq!(replay["replayed"], true);
    assert_eq!(replay["record"], before["record"]);
    let changed = command(
        &data,
        &[
            "add",
            "--id",
            "vera-retry",
            "--material",
            "Vera Example other book",
            "--actor",
            "Vera Example",
        ],
    )
    .output()
    .unwrap();
    assert_eq!(changed.status.code(), Some(3));
    assert_eq!(
        serde_json::from_slice::<Value>(&changed.stderr).unwrap()["current_revision"],
        1
    );
    run(
        &data,
        &[
            "edit",
            "--id",
            "vera-retry",
            "--if-revision",
            "1",
            "--note",
            "Vera Example correction",
        ],
    );
    assert_eq!(
        command(&data, &args).output().unwrap().status.code(),
        Some(3)
    );
    let stale = command(
        &data,
        &[
            "edit",
            "--id",
            "vera-retry",
            "--if-revision",
            "1",
            "--note",
            "Vera Example stale correction",
        ],
    )
    .output()
    .unwrap();
    assert_eq!(stale.status.code(), Some(3));
    assert_eq!(
        serde_json::from_slice::<Value>(&stale.stderr).unwrap()["current_revision"],
        2
    );
    run(&data, &["rm", "--id", "vera-retry", "--if-revision", "2"]);
    assert_eq!(
        command(&data, &args).output().unwrap().status.code(),
        Some(3)
    );
    let bytes = fs::read_to_string(data.path().join("records/vera-retry.json")).unwrap();
    assert!(!bytes.contains("Vera Example book"));
    assert!(!bytes.contains("Vera Example correction"));
}

#[test]
fn concurrent_writers_preserve_records_and_coordinate_marks() {
    let data = directory();
    let mut children = Vec::new();
    for number in 0..16 {
        let id = format!("vera-{number}");
        children.push(
            command(
                &data,
                &[
                    "add",
                    "--id",
                    &id,
                    "--material",
                    "Vera Example book",
                    "--actor",
                    "Vera Example",
                ],
            )
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
        );
    }
    for child in children {
        success(child.wait_with_output().unwrap());
    }
    assert_eq!(
        run(&data, &["list"])["records"].as_array().unwrap().len(),
        16
    );
    let mut children = Vec::new();
    for number in 0..12 {
        let material = format!("Vera Example book {number}");
        children.push(
            command(
                &data,
                &[
                    "mark",
                    "--material",
                    &material,
                    "--state",
                    "focus",
                    "--if-revision",
                    "0",
                ],
            )
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
        );
    }
    for child in children {
        success(child.wait_with_output().unwrap());
    }
    assert_eq!(
        run(&data, &["marks"])["marks"].as_object().unwrap().len(),
        12
    );
    for operation in ["edit", "mark"] {
        let mut children = Vec::new();
        for number in 0..8 {
            let note = format!("Vera Example correction {number}");
            let args = if operation == "edit" {
                vec![
                    "edit",
                    "--id",
                    "vera-0",
                    "--if-revision",
                    "1",
                    "--note",
                    &note,
                ]
            } else {
                vec![
                    "mark",
                    "--material",
                    "Vera Example contested book",
                    "--state",
                    "later",
                    "--if-revision",
                    "0",
                ]
            };
            children.push(
                command(&data, &args)
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn()
                    .unwrap(),
            );
        }
        let codes: Vec<_> = children
            .into_iter()
            .map(|c| c.wait_with_output().unwrap().status.code().unwrap())
            .collect();
        assert_eq!(codes.iter().filter(|&&code| code == 0).count(), 1);
        assert_eq!(codes.iter().filter(|&&code| code == 3).count(), 7);
    }
}

#[test]
fn observers_only_see_complete_replacements() {
    let data = directory();
    run(
        &data,
        &[
            "add",
            "--id",
            "vera-atomic",
            "--material",
            "Vera Example book",
            "--actor",
            "Vera Example",
        ],
    );
    let path = data.path().join("records/vera-atomic.json");
    let original = fs::File::open(&path).unwrap();
    let data_path = data.path().to_path_buf();
    let writer = thread::spawn(move || {
        for revision in 1..25 {
            let note = "Vera Example note ".repeat(1024);
            let output = Command::new(env!("CARGO_BIN_EXE_tatlas"))
                .arg("--data-dir")
                .arg(&data_path)
                .args([
                    "--json",
                    "edit",
                    "--id",
                    "vera-atomic",
                    "--if-revision",
                    &revision.to_string(),
                    "--note",
                    &note,
                ])
                .output()
                .unwrap();
            success(output);
        }
    });
    let mut samples = 0;
    while !writer.is_finished() {
        let value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(value["id"], "vera-atomic");
        assert!(value["interaction"]["material"].is_string());
        samples += 1;
        thread::yield_now();
    }
    writer.join().unwrap();
    assert!(samples > 0);
    let original: Value = serde_json::from_reader(original).unwrap();
    assert_eq!(original["revision"], 1);
    assert_eq!(
        run(&data, &["get", "--id", "vera-atomic"])["record"]["revision"],
        25
    );
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_TEMPORARY: u32 = 0x100;
        assert_eq!(
            fs::metadata(&path).unwrap().file_attributes() & FILE_ATTRIBUTE_TEMPORARY,
            0,
            "committed record must not remain temporary"
        );
    }
}

#[test]
fn kernel_lock_blocks_a_writer_and_releases_when_holder_dies() {
    let data = directory();
    run(
        &data,
        &[
            "add",
            "--id",
            "vera-lock",
            "--material",
            "Vera Example book",
            "--actor",
            "Vera Example",
        ],
    );
    let python = if cfg!(windows) { "python" } else { "python3" };
    let script = "import sys,time\nf=open(sys.argv[1], 'r+b')\nif sys.platform == 'win32':\n import msvcrt\n msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)\nelse:\n import fcntl\n fcntl.flock(f, fcntl.LOCK_EX)\nprint('Vera Example locked', flush=True)\ntime.sleep(30)";
    let mut holder = Command::new(python)
        .args(["-c", script])
        .arg(data.path().join(".lock"))
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut marker = String::new();
    BufReader::new(holder.stdout.take().unwrap())
        .read_line(&mut marker)
        .unwrap();
    assert_eq!(marker.trim(), "Vera Example locked");
    let mut writer = command(
        &data,
        &[
            "edit",
            "--id",
            "vera-lock",
            "--if-revision",
            "1",
            "--note",
            "Vera Example lock release",
        ],
    )
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .unwrap();
    thread::sleep(Duration::from_millis(75));
    assert!(writer.try_wait().unwrap().is_none());
    holder.kill().unwrap();
    holder.wait().unwrap();
    let start = Instant::now();
    while writer.try_wait().unwrap().is_none() {
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "writer did not resume after kernel lock release"
        );
        thread::sleep(Duration::from_millis(10));
    }
    success(writer.wait_with_output().unwrap());
}

#[test]
fn malformed_storage_and_bad_input_fail_without_overwriting_records() {
    let data = directory();
    run(
        &data,
        &[
            "add",
            "--id",
            "vera-malformed",
            "--material",
            "Vera Example book",
            "--actor",
            "Vera Example",
        ],
    );
    let path = data.path().join("records/vera-malformed.json");
    let before = fs::read(&path).unwrap();
    for id in ["Vera-example", "con", "nul", "com1", "lpt9"] {
        let output = command(
            &data,
            &[
                "add",
                "--id",
                id,
                "--material",
                "Vera Example",
                "--actor",
                "Vera Example",
            ],
        )
        .output()
        .unwrap();
        assert_eq!(output.status.code(), Some(1));
        assert!(
            serde_json::from_slice::<Value>(&output.stderr).unwrap()["error"]
                .as_str()
                .unwrap()
                .contains("id must contain")
        );
        assert_eq!(fs::read(&path).unwrap(), before);
    }
    for args in [
        vec![
            "edit",
            "--id",
            "vera-malformed",
            "--if-revision",
            "1",
            "--interaction-date",
            "2025-02-29",
        ],
        vec![
            "edit",
            "--id",
            "vera-malformed",
            "--if-revision",
            "1",
            "--note",
            "Vera Example",
            "--clear",
            "note",
        ],
        vec![
            "edit",
            "--id",
            "vera-malformed",
            "--if-revision",
            "1",
            "--actor",
            " ",
        ],
    ] {
        assert!(!command(&data, &args).output().unwrap().status.success());
        assert_eq!(fs::read(&path).unwrap(), before);
    }
    assert!(
        !command(
            &data,
            &[
                "add",
                "--id",
                "../escape",
                "--material",
                "Vera Example",
                "--actor",
                "Vera Example"
            ]
        )
        .output()
        .unwrap()
        .status
        .success()
    );
    for invalid in [
        b"{Vera Example".to_vec(),
        {
            let mut value: Value = serde_json::from_slice(&before).unwrap();
            value["unexpected"] = "Vera Example".into();
            serde_json::to_vec(&value).unwrap()
        },
        {
            let mut value: Value = serde_json::from_slice(&before).unwrap();
            value["id"] = "vera-other".into();
            serde_json::to_vec(&value).unwrap()
        },
    ] {
        fs::write(&path, &invalid).unwrap();
        for args in [
            vec!["get", "--id", "vera-malformed"],
            vec!["list"],
            vec![
                "edit",
                "--id",
                "vera-malformed",
                "--if-revision",
                "1",
                "--note",
                "Vera Example",
            ],
            vec!["rm", "--id", "vera-malformed", "--if-revision", "1"],
        ] {
            let output = command(&data, &args).output().unwrap();
            assert!(!output.status.success());
            assert!(output.stdout.is_empty());
            assert_eq!(fs::read(&path).unwrap(), invalid);
        }
    }
    fs::write(&path, before).unwrap();
    let marks = data.path().join("marks.json");
    for invalid in [
        "{Vera Example corrupt marks",
        r#"{"schema_version":1,"materials":{"Vera Example":{"revision":1,"state":"focus"},"Vera Example":{"revision":2,"state":"later"}}}"#,
        r#"{"schema_version":1,"materials":{"Vera Example":{"revision":0,"state":"focus"}}}"#,
    ] {
        fs::write(&marks, invalid).unwrap();
        assert!(
            !command(&data, &["marks"])
                .output()
                .unwrap()
                .status
                .success()
        );
        assert!(
            !command(
                &data,
                &[
                    "mark",
                    "--material",
                    "Vera Example",
                    "--state",
                    "focus",
                    "--if-revision",
                    "0"
                ]
            )
            .output()
            .unwrap()
            .status
            .success()
        );
        assert_eq!(fs::read_to_string(&marks).unwrap(), invalid);
    }
}

#[test]
fn read_commands_do_not_initialize_a_missing_store() {
    let root = directory();
    let missing = root.path().join("vera-example-missing");
    let output = Command::new(env!("CARGO_BIN_EXE_tatlas"))
        .arg("--data-dir")
        .arg(&missing)
        .args(["--json", "list"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(!missing.exists());
}
