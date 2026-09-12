mod support;

use support::{directory, run};

#[test]
fn exact_material_marks_are_independent_and_clearable() {
    let data = directory();
    let material = "https://example.org/Vera-Example";
    let other = "https://example.org/Vera-Example#part";
    let added = run(
        &data,
        &[
            "add",
            "--id",
            "vera-example",
            "--material",
            material,
            "--actor",
            "Vera Example",
        ],
    );
    run(
        &data,
        &[
            "add",
            "--id",
            "vera-example-other",
            "--material",
            other,
            "--actor",
            "Vera Example",
        ],
    );
    run(
        &data,
        &[
            "mark",
            "--material",
            material,
            "--state",
            "focus",
            "--if-revision",
            "0",
        ],
    );
    let focus = run(&data, &["list", "--state", "focus"]);
    assert_eq!(focus["records"].as_array().unwrap().len(), 1);
    assert_eq!(focus["records"][0]["id"], "vera-example");
    assert_eq!(
        run(&data, &["list", "--state", "none"])["records"][0]["id"],
        "vera-example-other"
    );
    assert!(
        run(&data, &["list", "--state", "focus", "--material", other])["records"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    run(
        &data,
        &[
            "mark",
            "--material",
            material,
            "--state",
            "later",
            "--if-revision",
            "1",
        ],
    );
    assert!(
        run(&data, &["list", "--state", "focus"])["records"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        run(&data, &["list", "--state", "later"])["records"][0]["id"],
        "vera-example"
    );
    run(
        &data,
        &[
            "mark",
            "--material",
            material,
            "--state",
            "none",
            "--if-revision",
            "2",
        ],
    );
    let marks = run(&data, &["marks"]);
    assert_eq!(marks["marks"][material]["state"], "none");
    assert_eq!(marks["marks"][material]["revision"], 3);
    assert_eq!(
        run(&data, &["get", "--id", "vera-example"])["record"],
        added["record"]
    );
    assert_eq!(
        run(&data, &["list"])["records"].as_array().unwrap().len(),
        2
    );
}

#[test]
fn a_mark_needs_no_interaction_and_record_deletion_does_not_clear_it() {
    let data = directory();
    let material = "Vera Example unsaved book";
    run(
        &data,
        &[
            "mark",
            "--material",
            material,
            "--state",
            "later",
            "--if-revision",
            "0",
        ],
    );
    assert!(
        run(&data, &["list"])["records"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    run(
        &data,
        &[
            "add",
            "--id",
            "marks",
            "--material",
            material,
            "--actor",
            "Vera Example",
        ],
    );
    run(&data, &["rm", "--id", "marks", "--if-revision", "1"]);
    assert_eq!(run(&data, &["marks"])["marks"][material]["state"], "later");
    assert_eq!(
        run(&data, &["get", "--id", "marks"])["record"]["status"],
        "deleted"
    );
}
