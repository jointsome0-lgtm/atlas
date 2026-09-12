mod model;
mod store;

use clap::{Args, Parser, Subcommand, ValueEnum};
use model::{Changes, Details, Interaction, Result, State};
use serde_json::{Value, json};
use std::io::{self, Write};
use std::path::PathBuf;
use store::Store;

const EXAMPLE_SETUP: &str = if cfg!(windows) {
    r#"Example in PowerShell. Use a fresh directory for invented Vera Example data:
  $ATLAS_DEMO_DIR = Join-Path ([IO.Path]::GetTempPath()) ("vera-example-atlas-" + [guid]::NewGuid())"#
} else {
    r#"Example in Bash. Use a fresh directory for invented Vera Example data:
  ATLAS_DEMO_DIR="$(mktemp -d /tmp/vera-example-atlas.XXXXXX)""#
};

const EXAMPLE_RECORD: &str = r#"  tatlas --data-dir "$ATLAS_DEMO_DIR" --json add --id vera-example-1 --material https://example.org/book --actor "Vera Example" --original "Vera Example: I opened the introduction.""#;

#[derive(Parser)]
#[command(
    name = "tatlas",
    version,
    about = "Keep a local log of a person's or agent's interactions with books, articles and other materials",
    after_help = r#"Start:
  tatlas add --help

Use the same private data directory for later commands. Keep real records outside
public code checkouts. Saving a reference alone does not claim reading.
The actor is the person or agent who interacted with the material.

Use tatlas <command> --help for its fields, example and recovery steps.
Exit codes: 0 success; 1 operation/storage error; 2 flag parsing error;
3 revision or ID conflict. After an uncertain write, read the current state."#
)]
struct Cli {
    #[arg(
        long,
        global = true,
        help = "Required for data commands: absolute private directory outside public code checkouts"
    )]
    data_dir: Option<PathBuf>,
    #[arg(
        long,
        global = true,
        help = "JSON results on stdout and errors on stderr; output only"
    )]
    json: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Args, Default)]
struct DetailArgs {
    #[arg(long, help = "Original statement, stored exactly as supplied")]
    original: Option<String>,
    #[arg(
        long,
        help = "Date of the interaction, YYYY-MM-DD; separate from when this record is saved"
    )]
    interaction_date: Option<String>,
    #[arg(
        long,
        help = "Supplied action label, for example opened or read; no action is inferred"
    )]
    action: Option<String>,
    #[arg(
        long,
        help = "Part of the material, for example introduction or pages 1-5"
    )]
    portion: Option<String>,
    #[arg(
        long,
        help = "Context text; list --context matches a case-sensitive substring"
    )]
    context: Option<String>,
    #[arg(long, help = "Additional note about this record")]
    note: Option<String>,
    #[arg(long, help = "Reference to related output, stored without fetching")]
    artifact: Option<String>,
}

impl From<DetailArgs> for Details {
    fn from(value: DetailArgs) -> Self {
        Self {
            original: value.original,
            interaction_date: value.interaction_date,
            action: value.action,
            portion: value.portion,
            context: value.context,
            note: value.note,
            artifact: value.artifact,
        }
    }
}

#[derive(Clone, Copy, ValueEnum)]
enum StateArg {
    Focus,
    Later,
    None,
}

impl From<StateArg> for State {
    fn from(value: StateArg) -> Self {
        match value {
            StateArg::Focus => Self::Focus,
            StateArg::Later => Self::Later,
            StateArg::None => Self::None,
        }
    }
}

#[derive(Subcommand)]
enum Command {
    #[command(
        about = "Save a material reference and any supplied account of interaction",
        after_help = format!(r#"Only --material and --actor are required record fields. Other fields are optional.
The data directory is initialized on the first write. Use a persistent private
directory for real records. A material reference alone claims no reading.

{EXAMPLE_SETUP}
{EXAMPLE_RECORD}
  tatlas --data-dir "$ATLAS_DEMO_DIR" --json get --id vera-example-1

The result contains record.id and record.revision. Keep the ID for later reads
and changes. A new record starts at revision 1.

Retry: choose and retain --id before sending add. The same ID and all the same
supplied fields confirm the existing record only while it is still at revision 1.
Changed fields, an edited record or a deleted ID produce a conflict.
If an automatically generated ID is lost, recover with list --material and get;
do not blindly repeat add. If several records match, the result is unresolved."#)
    )]
    Add {
        #[arg(
            long,
            help = "Choose and retain before add for safe retries; 1..64 lowercase ASCII letters, digits, '-' or '_'; no Windows device names"
        )]
        id: Option<String>,
        #[arg(
            long,
            help = "Exact URL or other material reference; stored without fetching or normalization"
        )]
        material: String,
        #[arg(
            long,
            help = "Person or agent who interacted with the material; do not infer from the caller"
        )]
        actor: String,
        #[command(flatten)]
        details: DetailArgs,
    },
    #[command(
        about = "List saved interactions",
        after_help = format!(r#"Lists live interactions, newest recording time first, then ascending ID for ties.
Filters combine with AND. Omit --state for All. --state none includes materials
that were never marked and materials whose marks were cleared.
The optional interaction date does not control this order.

{EXAMPLE_SETUP}
{EXAMPLE_RECORD}
  tatlas --data-dir "$ATLAS_DEMO_DIR" --json list --material https://example.org/book

The result contains a records array, with each record's ID and revision.
Reads require an initialized data directory. Malformed data makes the whole list
fail without partial output. Deletion receipts are available through get."#)
    )]
    List {
        #[arg(long, help = "Exact material reference; no URL normalization")]
        material: Option<String>,
        #[arg(long, help = "Case-sensitive substring in context")]
        context: Option<String>,
        #[arg(long, value_enum, help = "Current material mark; omit for All")]
        state: Option<StateArg>,
    },
    #[command(
        about = "Read one record and its revision",
        after_help = format!(r#"{EXAMPLE_SETUP}
{EXAMPLE_RECORD}
  tatlas --data-dir "$ATLAS_DEMO_DIR" --json get --id vera-example-1

The result contains record. Use record.revision as --if-revision when editing
or deleting this record. Read again before a later change.
A deleted record returns its ID/revision deletion receipt with status deleted.
An unknown ID is an error. This command does not change data."#)
    )]
    Get {
        #[arg(long, help = "Record ID from add or list")]
        id: String,
    },
    #[command(
        about = "Correct one record",
        after_help = format!(r#"First read get --id with the same data directory. Copy record.revision into
--if-revision. Supply at least one field to change or --clear FIELD.
Omitted fields, the record ID and recording time stay unchanged.
--clear removes an optional field; repeat it to clear several fields.

{EXAMPLE_SETUP}
{EXAMPLE_RECORD}
  tatlas --data-dir "$ATLAS_DEMO_DIR" --json get --id vera-example-1
  tatlas --data-dir "$ATLAS_DEMO_DIR" --json edit --id vera-example-1 --if-revision 1 --note "Vera Example correction"

Revision 1 is valid here because the example just created this record.
The result contains record with its updated revision.

On a revision conflict, get the current record and reconsider the change.
Do not merely increase --if-revision and repeat. After an uncertain result,
use get to compare fields and revision with the intended change. A matching
value alone does not prove which caller wrote it."#)
    )]
    Edit {
        #[arg(long, help = "Record ID from add or list")]
        id: String,
        #[arg(long, help = "Current record.revision from get; read before changing")]
        if_revision: u64,
        #[arg(
            long,
            help = "Correct the exact material reference; no fetching or normalization"
        )]
        material: Option<String>,
        #[arg(
            long,
            help = "Correct the stated person or agent; do not infer from the caller"
        )]
        actor: Option<String>,
        #[command(flatten)]
        details: DetailArgs,
        #[arg(long, value_parser = ["original", "interaction-date", "action", "portion", "context", "note", "artifact"], help = "Clear an optional field; repeat for multiple fields")]
        clear: Vec<String>,
    },
    #[command(
        about = "Delete one record's content",
        after_help = format!(r#"First read get --id with the same data directory. Copy record.revision into
--if-revision. Deletion removes content and keeps an ID/revision receipt.
The ID stays reserved; it cannot be reused for a new record.

{EXAMPLE_SETUP}
{EXAMPLE_RECORD}
  tatlas --data-dir "$ATLAS_DEMO_DIR" --json get --id vera-example-1
  tatlas --data-dir "$ATLAS_DEMO_DIR" --json rm --id vera-example-1 --if-revision 1

Revision 1 is valid here because the example just created this record.
The result contains record with status deleted and its new revision.

After an uncertain deletion, repeat rm with the same pre-deletion revision
to confirm its receipt without another write, or read get.
On a conflict, read get and reconsider the deletion; do not guess a revision.
Filesystem blocks and external backups are not securely erased."#)
    )]
    Rm {
        #[arg(long, help = "Record ID from add or list")]
        id: String,
        #[arg(long, help = "Current record.revision from get; read before deleting")]
        if_revision: u64,
    },
    #[command(
        about = "Set or clear a material's Focus/Later mark",
        after_help = format!(r#"First run marks with the same data directory. Find the exact material reference
in its marks object and use that entry's revision as --if-revision.
Use 0 only if the material is absent. Mark and record revisions are separate.

{EXAMPLE_SETUP}
{EXAMPLE_RECORD}
  tatlas --data-dir "$ATLAS_DEMO_DIR" --json marks
  tatlas --data-dir "$ATLAS_DEMO_DIR" --json mark --material https://example.org/book --state focus --if-revision 0

Revision 0 is valid here because the example's marks object is empty.
The result contains material and mark with its state and updated revision.
Focus and Later are mutually exclusive. --state none clears the mark and
increments its revision; it does not reset to 0. Marks are independent of records.
Marks can exist without records; mark can initialize an empty data directory.

On a conflict, run marks and reconsider the change. Do not merely increase
the revision and repeat. After an uncertain result, compare the material's
state and revision with the intended change; matching values alone do not
prove which caller wrote them."#)
    )]
    Mark {
        #[arg(long, help = "Exact material reference whose mark should change")]
        material: String,
        #[arg(
            long,
            value_enum,
            help = "focus: current focus; later: keep for later; none: clear"
        )]
        state: StateArg,
        #[arg(
            long,
            help = "Material's mark revision from marks; 0 only if absent, never a record revision"
        )]
        if_revision: u64,
    },
    #[command(
        about = "Read material marks and their revisions",
        after_help = format!(r#"{EXAMPLE_SETUP}
{EXAMPLE_RECORD}
  tatlas --data-dir "$ATLAS_DEMO_DIR" --json mark --material https://example.org/book --state focus --if-revision 0
  tatlas --data-dir "$ATLAS_DEMO_DIR" --json marks

The result contains a marks object keyed by exact material references.
Each entry has state and revision. Use that revision when changing the mark.
A cleared mark remains present with state none and its current revision;
only an absent entry uses revision 0. Reads require an initialized directory.
This command does not change data or read interaction records."#)
    )]
    Marks,
}

fn execute(cli: Cli) -> Result<Value> {
    let path = cli
        .data_dir
        .ok_or("--data-dir is required; choose a private directory outside the public checkout")?;
    let writable = !matches!(
        cli.command,
        Command::Get { .. } | Command::List { .. } | Command::Marks
    );
    let store = Store::open(&path, writable)?;
    match cli.command {
        Command::Add {
            id,
            material,
            actor,
            details,
        } => {
            let (record, replayed) = store.add(
                id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                Interaction {
                    material,
                    actor,
                    details: details.into(),
                },
            )?;
            Ok(json!({"operation": "add", "replayed": replayed, "record": record}))
        }
        Command::Edit {
            id,
            if_revision,
            material,
            actor,
            details,
            clear,
        } => {
            let details: Details = details.into();
            if material.is_none()
                && actor.is_none()
                && details == Details::default()
                && clear.is_empty()
            {
                return Err("edit requires a field to set or --clear".into());
            }
            let record = store.edit(
                &id,
                if_revision,
                Changes {
                    material,
                    actor,
                    details,
                    clear,
                },
            )?;
            Ok(json!({"operation": "edit", "record": record}))
        }
        Command::Rm { id, if_revision } => {
            let (record, replayed) = store.remove(&id, if_revision)?;
            Ok(json!({"operation": "rm", "replayed": replayed, "record": record}))
        }
        Command::Mark {
            material,
            state,
            if_revision,
        } => {
            let mark = store.mark(material.clone(), state.into(), if_revision)?;
            Ok(json!({"operation": "mark", "material": material, "mark": mark}))
        }
        Command::Get { id } => Ok(json!({"record": store.get(&id)?})),
        Command::List {
            material,
            context,
            state,
        } => Ok(
            json!({"records": store.list(material.as_deref(), context.as_deref(), state.map(Into::into))?}),
        ),
        Command::Marks => Ok(json!({"marks": store.marks()?})),
    }
}

fn readable(value: &Value) -> String {
    fn record(value: &Value) -> String {
        let id = value["id"].as_str().unwrap_or_default();
        let revision = &value["revision"];
        if value["status"] == "deleted" {
            return format!("{id} · revision {revision} · deleted\n");
        }
        let interaction = &value["interaction"];
        let recorded_at = time::OffsetDateTime::from_unix_timestamp_nanos(
            i128::from(value["recorded_at_ms"].as_u64().unwrap_or(0)) * 1_000_000,
        )
        .map(|time| {
            time.format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_else(|_| "invalid timestamp".into())
        })
        .unwrap_or_else(|_| "invalid timestamp".into());
        let mut result = format!(
            "{id} · revision {revision}\n  material: {}\n  actor: {}\n  recorded-at: {}\n",
            interaction["material"], interaction["actor"], recorded_at
        );
        if let Some(details) = interaction["details"].as_object() {
            for (key, value) in details {
                if !value.is_null() {
                    result.push_str(&format!("  {key}: {value}\n"));
                }
            }
        }
        result
    }
    if value.get("record").is_some() {
        let mut text = record(&value["record"]);
        if value["replayed"] == true {
            text.push_str("Existing result confirmed; no new write.\n");
        }
        return text;
    }
    if let Some(records) = value["records"].as_array() {
        let mut text = format!("{} interaction(s)\n", records.len());
        for item in records {
            text.push_str(&record(item));
        }
        return text;
    }
    if let Some(marks) = value["marks"].as_object() {
        let mut text = format!(
            "{} material mark(s), including cleared marks\n",
            marks.len()
        );
        for (material, mark) in marks {
            text.push_str(&format!(
                "{} · {} · revision {}\n",
                json!(material),
                mark["state"],
                mark["revision"]
            ));
        }
        return text;
    }
    format!(
        "{} · {} · revision {}\n",
        value["material"], value["mark"]["state"], value["mark"]["revision"]
    )
}

fn main() {
    let arguments: Vec<_> = std::env::args_os().collect();
    let wants_json = arguments.iter().any(|arg| arg == "--json");
    let cli = match Cli::try_parse_from(arguments) {
        Ok(cli) => cli,
        Err(error) => {
            if error.use_stderr() && wants_json {
                eprintln!("{}", json!({"error": error.to_string()}));
                std::process::exit(2);
            }
            error.exit();
        }
    };
    let json = cli.json;
    match execute(cli) {
        Ok(value) => {
            let output = if json {
                format!("{value}\n")
            } else {
                readable(&value)
            };
            if let Err(error) = io::stdout().lock().write_all(output.as_bytes()) {
                let message = format!(
                    "output failed: {error}; the operation may have committed; read current state before retrying"
                );
                if json {
                    eprintln!("{}", json!({"error": message}));
                } else {
                    eprintln!("tatlas: {message}");
                }
                std::process::exit(1);
            }
        }
        Err(error) => {
            if json {
                eprintln!(
                    "{}",
                    json!({"error": error.to_string(), "current_revision": error.current_revision})
                );
            } else {
                eprintln!("tatlas: {error}");
            }
            std::process::exit(if error.current_revision.is_some() {
                3
            } else {
                1
            });
        }
    }
}
