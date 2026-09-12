use crate::model::{
    Changes, Error, Interaction, Mark, Record, Result, State, conflict, nonblank, validate_id,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Marks {
    schema_version: u32,
    #[serde(deserialize_with = "unique_marks")]
    materials: BTreeMap<String, Mark>,
}

fn unique_marks<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<BTreeMap<String, Mark>, D::Error> {
    struct Unique;
    impl<'de> serde::de::Visitor<'de> for Unique {
        type Value = BTreeMap<String, Mark>;
        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("unique material references")
        }
        fn visit_map<A: serde::de::MapAccess<'de>>(
            self,
            mut map: A,
        ) -> std::result::Result<Self::Value, A::Error> {
            let mut materials = BTreeMap::new();
            while let Some((material, mark)) = map.next_entry::<String, Mark>()? {
                if materials.insert(material, mark).is_some() {
                    return Err(serde::de::Error::custom("duplicate material reference"));
                }
            }
            Ok(materials)
        }
    }
    deserializer.deserialize_map(Unique)
}

pub struct Store {
    directory: PathBuf,
    _lock: File,
}

fn io(error: std::io::Error) -> Error {
    error.to_string().into()
}

fn regular_file(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_file() => Ok(true),
        Ok(_) => Err(format!("expected a regular file: {}", path.display()).into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(io(error)),
    }
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    if !regular_file(path)? {
        return Ok(None);
    }
    let bytes = fs::read(path).map_err(io)?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| Error::from(format!("invalid storage {}: {error}", path.display())))
}

fn next_revision(current: u64) -> Result<u64> {
    current
        .checked_add(1)
        .ok_or_else(|| "revision exhausted".into())
}

fn expect_revision(actual: u64, expected: u64) -> Result<()> {
    if actual == expected {
        Ok(())
    } else {
        Err(conflict(
            format!(
                "revision conflict: expected {expected}, current {actual}; read current state before retrying"
            ),
            actual,
        ))
    }
}

impl Store {
    pub fn open(path: &Path, writable: bool) -> Result<Self> {
        if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
            return Err(
                "data-dir must be an absolute path without '..', outside the public checkout"
                    .into(),
            );
        }
        let mut ancestor = path;
        let mut suffix = Vec::new();
        while !ancestor.exists() {
            suffix.push(ancestor.file_name().ok_or("invalid data-dir")?);
            ancestor = ancestor.parent().ok_or("invalid data-dir")?;
        }
        let mut resolved = ancestor.canonicalize().map_err(io)?;
        for part in suffix.iter().rev() {
            resolved.push(part);
        }
        if !writable && !resolved.is_dir() {
            return Err(
                "data directory is not initialized; add a record or mark a material first".into(),
            );
        }
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        if writable {
            builder.create(&resolved).map_err(io)?;
        }
        let lock_path = resolved.join(".lock");
        if !regular_file(&lock_path)? && !writable {
            return Err(
                "data directory is not initialized; add a record or mark a material first".into(),
            );
        }
        let mut options = OpenOptions::new();
        options
            .create(writable)
            .read(true)
            .write(writable)
            .truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lock = options.open(lock_path).map_err(io)?;
        if writable {
            lock.lock().map_err(io)?;
        } else {
            lock.lock_shared().map_err(io)?;
        }
        let records = resolved.join("records");
        if records.exists()
            && !fs::symlink_metadata(&records)
                .map_err(io)?
                .file_type()
                .is_dir()
        {
            return Err("records must be a directory, not a symlink or file".into());
        }
        if writable {
            builder.create(&records).map_err(io)?;
            File::open(&resolved)
                .and_then(|f| f.sync_all())
                .map_err(io)?;
            let mut parent = if resolved != ancestor {
                resolved.parent()
            } else {
                None
            };
            while let Some(path) = parent {
                File::open(path).and_then(|f| f.sync_all()).map_err(io)?;
                if path == ancestor {
                    break;
                }
                parent = path.parent();
            }
        } else if !records.is_dir() {
            return Err("data directory is not initialized: missing records directory".into());
        }
        Ok(Self {
            directory: resolved,
            _lock: lock,
        })
    }

    fn write<T: Serialize>(&self, path: &Path, value: &T) -> Result<()> {
        regular_file(path)?;
        let parent = path.parent().ok_or("missing storage parent")?;
        let mut file = tempfile::Builder::new()
            .prefix(".atlas-")
            .tempfile_in(parent)
            .map_err(io)?;
        serde_json::to_writer_pretty(file.as_file_mut(), value).map_err(|e| e.to_string())?;
        file.write_all(b"\n").map_err(io)?;
        file.as_file().sync_all().map_err(io)?;
        file.persist(path).map_err(|e| io(e.error))?;
        File::open(parent).and_then(|f| f.sync_all()).map_err(|error| {
            Error::from(format!("write may have committed but directory sync failed: {error}; read current state before retrying"))
        })
    }

    fn record_path(&self, id: &str) -> Result<PathBuf> {
        validate_id(id)?;
        Ok(self.directory.join("records").join(format!("{id}.json")))
    }

    pub fn get(&self, id: &str) -> Result<Record> {
        let record: Record =
            read_json(&self.record_path(id)?)?.ok_or_else(|| format!("record {id} not found"))?;
        record.validate(id)?;
        Ok(record)
    }

    pub fn add(&self, id: String, interaction: Interaction) -> Result<(Record, bool)> {
        interaction.validate()?;
        let path = self.record_path(&id)?;
        if let Some(record) = read_json::<Record>(&path)? {
            record.validate(&id)?;
            if matches!(&record, Record::Live { revision: 1, interaction: old, .. } if **old == interaction)
            {
                return Ok((record, true));
            }
            return Err(conflict(
                format!(
                    "ID {id} already used at revision {}; get it before retrying; choose a new ID only for a new interaction",
                    record.revision()
                ),
                record.revision(),
            ));
        }
        let recorded_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis()
            .try_into()
            .map_err(|_| "clock out of range")?;
        let record = Record::Live {
            schema_version: 1,
            id,
            revision: 1,
            recorded_at_ms,
            interaction: Box::new(interaction),
        };
        self.write(&path, &record)?;
        Ok((record, false))
    }

    pub fn edit(&self, id: &str, revision: u64, changes: Changes) -> Result<Record> {
        let mut record = self.get(id)?;
        expect_revision(record.revision(), revision)?;
        match &mut record {
            Record::Live {
                revision,
                interaction,
                ..
            } => {
                changes.apply(interaction)?;
                *revision = next_revision(*revision)?;
            }
            Record::Deleted { .. } => {
                return Err(conflict(format!("record {id} is deleted"), revision));
            }
        }
        self.write(&self.record_path(id)?, &record)?;
        Ok(record)
    }

    pub fn remove(&self, id: &str, expected: u64) -> Result<(Record, bool)> {
        let current = self.get(id)?;
        if let Record::Deleted { revision, .. } = &current {
            if expected.checked_add(1) == Some(*revision) {
                return Ok((current, true));
            }
            return Err(conflict(
                format!("record {id} already deleted at revision {revision}"),
                *revision,
            ));
        }
        expect_revision(current.revision(), expected)?;
        let record = Record::Deleted {
            schema_version: 1,
            id: id.to_string(),
            revision: next_revision(expected)?,
        };
        self.write(&self.record_path(id)?, &record)?;
        Ok((record, false))
    }

    fn load_marks(&self) -> Result<Marks> {
        let marks: Marks =
            read_json(&self.directory.join("marks.json"))?.unwrap_or_else(|| Marks {
                schema_version: 1,
                materials: BTreeMap::new(),
            });
        if marks.schema_version != 1 {
            return Err("unsupported marks schema".into());
        }
        for (material, mark) in &marks.materials {
            nonblank("stored material", material)?;
            if mark.revision == 0 {
                return Err("invalid stored mark revision 0".into());
            }
        }
        Ok(marks)
    }

    pub fn marks(&self) -> Result<BTreeMap<String, Mark>> {
        Ok(self.load_marks()?.materials)
    }

    pub fn mark(&self, material: String, state: State, expected: u64) -> Result<Mark> {
        nonblank("material", &material)?;
        let mut marks = self.load_marks()?;
        let revision = marks.materials.get(&material).map_or(0, |m| m.revision);
        expect_revision(revision, expected)?;
        let mark = Mark {
            revision: next_revision(revision)?,
            state,
        };
        marks.materials.insert(material, mark.clone());
        self.write(&self.directory.join("marks.json"), &marks)?;
        Ok(mark)
    }

    pub fn list(
        &self,
        material: Option<&str>,
        context: Option<&str>,
        state: Option<State>,
    ) -> Result<Vec<Record>> {
        let marks = if state.is_some() {
            self.marks()?
        } else {
            BTreeMap::new()
        };
        let mut records = Vec::new();
        for entry in fs::read_dir(self.directory.join("records")).map_err(io)? {
            let entry = entry.map_err(io)?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| "invalid record filename")?;
            if name.starts_with(".atlas-") {
                continue;
            }
            let id = name
                .strip_suffix(".json")
                .ok_or_else(|| format!("unexpected storage entry {name}"))?;
            let record = self.get(id)?;
            if let Record::Live { interaction, .. } = &record {
                let current = marks
                    .get(&interaction.material)
                    .map_or(State::None, |m| m.state);
                if material.is_none_or(|m| interaction.material == m)
                    && context.is_none_or(|c| {
                        interaction
                            .details
                            .context
                            .as_deref()
                            .is_some_and(|v| v.contains(c))
                    })
                    && state.is_none_or(|s| current == s)
                {
                    records.push(record);
                }
            }
        }
        records.sort_by(|a, b| match (a, b) {
            (
                Record::Live {
                    recorded_at_ms: a_time,
                    ..
                },
                Record::Live {
                    recorded_at_ms: b_time,
                    ..
                },
            ) => b_time.cmp(a_time).then_with(|| a.id().cmp(b.id())),
            _ => unreachable!("list contains only live records"),
        });
        Ok(records)
    }
}
