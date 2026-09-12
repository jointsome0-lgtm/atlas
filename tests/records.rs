mod support;

use serde_json::{Value, json};
use std::fs;
use std::process::Command;
use support::{command, directory, run};

#[test]
fn bare_reference_preserves_exact_actor_and_material_without_claiming_action() {
    let data = directory();
    let added = run(
        &data,
        &[
            "add",
            "--material",
            "HTTPS://example.org/Vera%20Example#Part",
            "--actor",
            "Vera Example's agent",
        ],
    );
    let record = &added["record"];
    assert_eq!(record["revision"], 1);
    assert_eq!(record["interaction"]["actor"], "Vera Example's agent");
    assert_eq!(
        record["interaction"]["material"],
        "HTTPS://example.org/Vera%20Example#Part"
    );
    assert!(record["interaction"]["details"]["action"].is_null());
    assert!(record["recorded_at_ms"].as_u64().unwrap() > 0);
    let id = record["id"].as_str().unwrap();
    assert_eq!(run(&data, &["get", "--id", id])["record"], *record);
    assert_eq!(
        run(&data, &["list"])["records"].as_array().unwrap().len(),
        1
    );
}

#[test]
fn correction_and_deletion_have_durable_receipts() {
    let data = directory();
    let added = run(
        &data,
        &[
            "add",
            "--id",
            "vera-example",
            "--material",
            "https://example.org/book",
            "--actor",
            "Vera Example",
            "--original",
            "  Vera Example: I opened it.\nBut did not read it.  ",
            "--interaction-date",
            "2024-02-29",
            "--action",
            "opened",
            "--portion",
            "title",
            "--context",
            "Vera Example research",
            "--note",
            "Vera Example draft",
            "--artifact",
            "https://example.org/vera-artifact",
        ],
    );
    let edited = run(
        &data,
        &[
            "edit",
            "--id",
            "vera-example",
            "--if-revision",
            "1",
            "--material",
            "https://example.org/book#title",
            "--actor",
            "Vera Example's agent",
            "--note",
            "Vera Example correction",
            "--clear",
            "action",
            "--clear",
            "portion",
        ],
    );
    assert_eq!(edited["record"]["revision"], 2);
    assert_eq!(
        edited["record"]["recorded_at_ms"],
        added["record"]["recorded_at_ms"]
    );
    assert_eq!(
        edited["record"]["interaction"]["details"]["original"],
        added["record"]["interaction"]["details"]["original"]
    );
    assert_eq!(
        edited["record"]["interaction"]["details"]["note"],
        "Vera Example correction"
    );
    assert!(edited["record"]["interaction"]["details"]["action"].is_null());
    assert!(edited["record"]["interaction"]["details"]["portion"].is_null());
    assert_eq!(
        run(&data, &["get", "--id", "vera-example"])["record"],
        edited["record"]
    );
    let deleted = run(&data, &["rm", "--id", "vera-example", "--if-revision", "2"]);
    assert_eq!(
        deleted["record"],
        json!({"schema_version": 1, "status": "deleted", "id": "vera-example", "revision": 3})
    );
    assert_eq!(
        run(&data, &["get", "--id", "vera-example"])["record"],
        deleted["record"]
    );
    assert!(
        run(&data, &["list"])["records"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        run(&data, &["rm", "--id", "vera-example", "--if-revision", "2"])["replayed"],
        true
    );
}

#[test]
fn list_orders_by_recording_time_and_id_with_exact_material_and_context_filters() {
    let data = directory();
    for (id, material, context, recorded_at_ms, interaction_date) in [
        (
            "vera-b",
            "https://example.org/book",
            "Vera Example research",
            1_700_000_002_000_u64,
            "2099-01-01",
        ),
        (
            "vera-z",
            "https://example.org/book",
            "Vera Example research",
            1_700_000_003_000,
            "1900-01-01",
        ),
        (
            "vera-a",
            "https://example.org/book",
            "Vera Example research",
            1_700_000_002_000,
            "2098-01-01",
        ),
        (
            "vera-0",
            "https://example.org/book#part",
            "Vera Example reading",
            1_700_000_002_500,
            "2100-01-01",
        ),
    ] {
        run(
            &data,
            &[
                "add",
                "--id",
                id,
                "--material",
                material,
                "--actor",
                "Vera Example",
                "--context",
                context,
                "--interaction-date",
                interaction_date,
            ],
        );
        let path = data.path().join("records").join(format!("{id}.json"));
        let mut fixture: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        fixture["recorded_at_ms"] = recorded_at_ms.into();
        fs::write(path, serde_json::to_vec(&fixture).unwrap()).unwrap();
    }
    let ids = |result: Value| {
        result["records"]
            .as_array()
            .unwrap()
            .iter()
            .map(|record| record["id"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    assert_eq!(
        ids(run(&data, &["list"])),
        ["vera-z", "vera-0", "vera-a", "vera-b"]
    );
    assert_eq!(
        ids(run(
            &data,
            &["list", "--material", "https://example.org/book"]
        )),
        ["vera-z", "vera-a", "vera-b"]
    );
    assert_eq!(
        ids(run(&data, &["list", "--context", "research"])),
        ["vera-z", "vera-a", "vera-b"]
    );
    assert!(ids(run(&data, &["list", "--context", "Research"])).is_empty());
    assert!(
        ids(run(
            &data,
            &[
                "list",
                "--material",
                "https://example.org/book#part",
                "--context",
                "research"
            ]
        ))
        .is_empty()
    );
}

#[test]
fn help_and_errors_are_usable_without_storage() {
    let help = Command::new(env!("CARGO_BIN_EXE_tatlas"))
        .arg("--help")
        .output()
        .unwrap();
    assert!(help.status.success());
    let help = String::from_utf8(help.stdout).unwrap();
    for term in [
        "Vera Example",
        "--if-revision",
        "--json",
        "Retry",
        "--state none",
    ] {
        assert!(help.contains(term), "missing {term}");
    }
    let add_help = Command::new(env!("CARGO_BIN_EXE_tatlas"))
        .args(["add", "--help"])
        .output()
        .unwrap();
    assert!(add_help.status.success());
    assert!(String::from_utf8_lossy(&add_help.stdout).contains("do not blindly repeat"));
    let missing_actor = command(&directory(), &["add", "--material", "Vera Example book"])
        .output()
        .unwrap();
    assert_eq!(missing_actor.status.code(), Some(2));
    assert!(
        serde_json::from_slice::<serde_json::Value>(&missing_actor.stderr).unwrap()["error"]
            .as_str()
            .unwrap()
            .contains("--actor")
    );
    let missing_data = Command::new(env!("CARGO_BIN_EXE_tatlas"))
        .args(["--json", "list"])
        .output()
        .unwrap();
    assert!(!missing_data.status.success());
    assert!(String::from_utf8_lossy(&missing_data.stderr).contains("--data-dir"));
    let data = directory();
    let readable = Command::new(env!("CARGO_BIN_EXE_tatlas"))
        .arg("--data-dir")
        .arg(data.path())
        .args([
            "add",
            "--material",
            "Vera Example book",
            "--actor",
            "Vera Example",
        ])
        .output()
        .unwrap();
    assert!(readable.status.success());
    assert!(String::from_utf8_lossy(&readable.stdout).contains("revision 1"));
    assert!(String::from_utf8_lossy(&readable.stdout).contains("recorded-at: 20"));
}
