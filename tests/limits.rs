use std::fs;
use std::path::Path;
use std::process::{Command, Output};
use tempfile::TempDir;

fn limits(root: &Path) -> Output {
    Command::new(if cfg!(windows) { "python" } else { "python3" })
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/limits.py"))
        .arg("--root")
        .arg(root)
        .output()
        .unwrap()
}

fn stage(root: &Path) {
    assert!(
        Command::new("git")
            .current_dir(root)
            .args(["add", "--all", "--force", "--", ".", ":!target"])
            .status()
            .unwrap()
            .success()
    );
}

fn fixture() -> TempDir {
    let root = tempfile::Builder::new()
        .prefix("vera-example-limits-")
        .tempdir()
        .unwrap();
    assert!(
        Command::new("git")
            .current_dir(root.path())
            .args(["init", "--quiet"])
            .status()
            .unwrap()
            .success()
    );
    fs::create_dir(root.path().join("src")).unwrap();
    fs::create_dir(root.path().join("tests")).unwrap();
    for (name, text) in [
        (
            "Cargo.toml",
            "[package]\nname = \"vera-example-limits\"\nversion = \"0.1.0\"\nedition = \"2024\"\n",
        ),
        (
            "src/main.rs",
            "fn main() { let _ = \"Vera Example // literal\"; }\n",
        ),
        (
            "tests/check.rs",
            "#[test]\nfn vera_example() { let _ = r###\"Vera Example /* literal */\"###; }\n",
        ),
        (
            "README.md",
            "# Vera Example\n\n## Map\n\n- `src/`: Vera Example executable.\n- `tests/`: Vera Example tests.\n",
        ),
        (
            "GOALS.md",
            "# Vera Example\n\n1. Vera Example boundary. `tests/check.rs`\n",
        ),
        ("AGENTS.md", "Vera Example rules.\n"),
    ] {
        fs::write(root.path().join(name), text).unwrap();
    }
    fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR")).join(".gitignore"),
        root.path().join(".gitignore"),
    )
    .unwrap();
    assert!(
        Command::new("cargo")
            .current_dir(root.path())
            .args(["generate-lockfile", "--offline"])
            .status()
            .unwrap()
            .success()
    );
    stage(root.path());
    root
}

fn expect_failure(root: &Path, needle: &str) {
    let output = limits(root);
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        !output.status.success(),
        "checker accepted invalid fixture: {needle}"
    );
    assert!(text.contains(needle), "missing {needle}: {text}");
}

#[test]
fn repository_meets_its_limits() {
    let output = limits(Path::new(env!("CARGO_MANIFEST_DIR")));
    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn rust_checks_distinguish_literals_from_comments_and_reject_source_inclusion() {
    let root = fixture();
    let valid = limits(root.path());
    assert!(
        valid.status.success(),
        "{}{}",
        String::from_utf8_lossy(&valid.stdout),
        String::from_utf8_lossy(&valid.stderr)
    );
    for (source, message) in [
        (
            "// Vera Example comment\nfn main() {}\n",
            "Rust comments are forbidden",
        ),
        (
            "/* Vera Example block */ fn main() {}\n",
            "Rust comments are forbidden",
        ),
        (
            "/// Vera Example docs\nfn main() {}\n",
            "Rust comments are forbidden",
        ),
        (
            "#[doc = \"Vera Example docs\"]\nfn main() {}\n",
            "documentation attributes are forbidden",
        ),
        (
            "fn main() {}\n#[test] fn vera_example_internal() {}\n",
            "goal-bound integration targets",
        ),
        (
            "fn main() {}\n#[cfg(test)] mod checks {}\n",
            "test modules do not belong",
        ),
    ] {
        fs::write(root.path().join("src/main.rs"), source).unwrap();
        stage(root.path());
        expect_failure(root.path(), message);
    }
    fs::write(root.path().join("src/main.rs"), "fn main() {}\n").unwrap();
    for (source, message) in [
        (
            "include!(\"../src/main.rs\");\n#[test] fn vera_example() {}\n",
            "not source inclusion",
        ),
        (
            "#[path = \"../src/main.rs\"] mod implementation;\n#[test] fn vera_example() {}\n",
            "must not load source",
        ),
        (
            "#[test] #[ignore] fn vera_example() {}\n",
            "must not be ignored",
        ),
        (
            "use std::include as load; load!(\"../src/main.rs\"); #[test] fn vera_example() {}\n",
            "source-inclusion macros",
        ),
        (
            "#[cfg(any())] #[test] fn vera_example() {}\n",
            "Cargo discovered no runnable tests",
        ),
    ] {
        fs::write(root.path().join("tests/check.rs"), source).unwrap();
        stage(root.path());
        expect_failure(root.path(), message);
    }
    fs::write(
        root.path().join("tests/check.rs"),
        "fn vera_example_but_not_a_test() {}\n",
    )
    .unwrap();
    stage(root.path());
    expect_failure(root.path(), "has no #[test]");
}

#[test]
fn goals_map_budget_and_markdown_are_enforced() {
    for (name, contents, needle) in [
        (
            "GOALS.md",
            "# Vera Example\n\n1. Unbound Vera Example goal.\n",
            "exactly one Rust test",
        ),
        (
            "GOALS.md",
            "# Vera Example\n\n1. Vera Example. `tests/check.rs`\n\n2. Vera Example duplicate. `tests/check.rs`\n",
            "bind each Rust test target exactly once",
        ),
        (
            "README.md",
            "# Vera Example\n\n## Map\n\n- `src/`: Vera Example.\n",
            "Map must list",
        ),
        (
            "extra.md",
            "Vera Example extra Markdown\n",
            "Markdown is not allowed",
        ),
    ] {
        let root = fixture();
        fs::write(root.path().join(name), contents).unwrap();
        stage(root.path());
        expect_failure(root.path(), needle);
    }
    let root = fixture();
    fs::write(
        root.path().join("large.txt"),
        "Vera Example ".repeat(24_000),
    )
    .unwrap();
    stage(root.path());
    expect_failure(root.path(), "budget exceeded");
    let root = fixture();
    fs::write(
        root.path().join("README.md"),
        format!(
            "# Vera Example\n\n## Map\n\n- `src/`: {}\n- `tests/`: Vera Example.\n",
            "Vera Example ".repeat(25)
        ),
    )
    .unwrap();
    stage(root.path());
    expect_failure(root.path(), "invalid Map line");
}

#[test]
fn public_hygiene_uses_staged_content_and_rejects_private_paths() {
    let root = fixture();
    fs::create_dir(root.path().join("fixtures")).unwrap();
    fs::write(
        root.path().join("fixtures/sample.txt"),
        "Invented but unmarked",
    )
    .unwrap();
    stage(root.path());
    fs::write(
        root.path().join("fixtures/sample.txt"),
        "Vera Example unstaged masking edit",
    )
    .unwrap();
    expect_failure(root.path(), "fixture lacks Vera Example");
    for name in [
        "secrets/token.txt",
        "nested/example.sqlite-wal",
        "nested/.env.secret",
        "nested/run.jsonl",
    ] {
        let root = fixture();
        let path = root.path().join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "Vera Example forbidden fixture").unwrap();
        stage(root.path());
        expect_failure(root.path(), "private path visible");
    }
    let root = fixture();
    let ignore = fs::read_to_string(root.path().join(".gitignore")).unwrap();
    fs::write(
        root.path().join(".gitignore"),
        ignore.replace("data/\n", ""),
    )
    .unwrap();
    stage(root.path());
    fs::write(root.path().join(".gitignore"), ignore).unwrap();
    expect_failure(root.path(), "missing required pattern: data/");
}

#[test]
#[cfg(unix)]
fn tracked_symlinks_fail() {
    let root = fixture();
    std::os::unix::fs::symlink("src/main.rs", root.path().join("vera-link")).unwrap();
    stage(root.path());
    expect_failure(root.path(), "tracked symlink is forbidden");
}
