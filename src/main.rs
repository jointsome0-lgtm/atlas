mod model;
mod store;

use clap::{Args, Parser, Subcommand, ValueEnum};
use model::{Changes, Details, Interaction, Result, State};
use serde_json::{Value, json};
use std::io::{self, Write};
use std::path::PathBuf;
use store::Store;

#[derive(Parser)]
#[command(
    name = "tatlas",
    version,
    about = "Record interactions with materials in an explicit private directory",
    after_help = "Examples (invented Vera Example data):\n  tatlas --data-dir /tmp/vera-atlas add --material https://example.org/book --actor 'Vera Example'\n  tatlas --data-dir /tmp/vera-atlas --json add --id vera-note-1 --material https://example.org/book --actor 'Vera Example' --context 'Vera Example research'\n  tatlas --data-dir /tmp/vera-atlas list --material https://example.org/book\n  tatlas --data-dir /tmp/vera-atlas list --context research --state focus\n  tatlas --data-dir /tmp/vera-atlas get --id vera-note-1\n  tatlas --data-dir /tmp/vera-atlas edit --id vera-note-1 --if-revision 1 --note 'Vera Example correction'\n  tatlas --data-dir /tmp/vera-atlas rm --id vera-note-1 --if-revision 2\n  tatlas --data-dir /tmp/vera-atlas mark --material https://example.org/book --state focus --if-revision 0\n  tatlas --data-dir /tmp/vera-atlas marks\n  tatlas --data-dir /tmp/vera-atlas mark --material https://example.org/book --state none --if-revision 1\n\nRetry: retain --id before add for safe identical retries at revision 1.\nWithout a known ID, recover an uncertain add using list/get; do not blindly repeat.\nAfter an uncertain edit or mark, read get/marks and reconcile the revision.\nAll means list without --state. A bare reference does not imply reading."
)]
struct Cli {
    #[arg(
        long,
        global = true,
        help = "Absolute private data directory outside the public checkout"
    )]
    data_dir: Option<PathBuf>,
    #[arg(long, global = true, help = "Emit JSON receipts, results and errors")]
    json: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Args, Default)]
struct DetailArgs {
    #[arg(long, help = "Exact original statement, preserved as supplied")]
    original: Option<String>,
    #[arg(
        long,
        help = "Interaction date, YYYY-MM-DD; independent of recording time"
    )]
    interaction_date: Option<String>,
    #[arg(long)]
    action: Option<String>,
    #[arg(long)]
    portion: Option<String>,
    #[arg(long)]
    context: Option<String>,
    #[arg(long)]
    note: Option<String>,
    #[arg(long, help = "Artifact link, stored without fetching")]
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
        about = "Save an interaction; no action is inferred",
        after_help = "For safe retries, choose and retain --id before add. An identical retry at revision 1 confirms the existing record. If a generated-ID result is lost, recover with list --material and get; do not blindly repeat add."
    )]
    Add {
        #[arg(
            long,
            help = "Optional stable retry key: 1..64 lowercase ASCII letters, digits, '-' or '_'; no Windows device names"
        )]
        id: Option<String>,
        #[arg(long)]
        material: String,
        #[arg(
            long,
            help = "Explicit person or agent responsible for this interaction"
        )]
        actor: String,
        #[command(flatten)]
        details: DetailArgs,
    },
    #[command(
        about = "List newest recorded interactions first, then ID for ties; filters combine with AND"
    )]
    List {
        #[arg(long, help = "Exact material reference; no URL normalization")]
        material: Option<String>,
        #[arg(long, help = "Case-sensitive substring in context")]
        context: Option<String>,
        #[arg(long, value_enum, help = "Current material mark; omit for All")]
        state: Option<StateArg>,
    },
    #[command(about = "Read a record, including a deletion receipt")]
    Get {
        #[arg(long)]
        id: String,
    },
    #[command(about = "Correct supplied fields; leave omitted fields unchanged")]
    Edit {
        #[arg(long)]
        id: String,
        #[arg(long)]
        if_revision: u64,
        #[arg(long)]
        material: Option<String>,
        #[arg(long)]
        actor: Option<String>,
        #[command(flatten)]
        details: DetailArgs,
        #[arg(long, value_parser = ["original", "interaction-date", "action", "portion", "context", "note", "artifact"], help = "Clear an optional field; repeat for multiple fields")]
        clear: Vec<String>,
    },
    #[command(about = "Delete record content, retaining only its ID/revision deletion receipt")]
    Rm {
        #[arg(long)]
        id: String,
        #[arg(long)]
        if_revision: u64,
    },
    #[command(about = "Set one material's current mark; revision 0 means never marked")]
    Mark {
        #[arg(long)]
        material: String,
        #[arg(long, value_enum)]
        state: StateArg,
        #[arg(long)]
        if_revision: u64,
    },
    #[command(about = "Read current marks and their revisions, including cleared marks")]
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
