use serde::{Deserialize, Serialize};

#[derive(Debug)]
pub struct Error {
    pub message: String,
    pub current_revision: Option<u64>,
}

impl From<String> for Error {
    fn from(message: String) -> Self {
        Self {
            message,
            current_revision: None,
        }
    }
}

impl From<&str> for Error {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.message.fmt(formatter)
    }
}

pub fn conflict(message: String, current_revision: u64) -> Error {
    Error {
        message,
        current_revision: Some(current_revision),
    }
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Details {
    pub original: Option<String>,
    pub interaction_date: Option<String>,
    pub action: Option<String>,
    pub portion: Option<String>,
    pub context: Option<String>,
    pub note: Option<String>,
    pub artifact: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Interaction {
    pub material: String,
    pub actor: String,
    pub details: Details,
}

impl Interaction {
    pub fn validate(&self) -> Result<()> {
        nonblank("material", &self.material)?;
        nonblank("actor", &self.actor)?;
        if let Some(date) = &self.details.interaction_date {
            let format =
                time::format_description::parse_borrowed::<2>("[year]-[month]-[day]").unwrap();
            if date.len() != 10 || time::Date::parse(date, &format).is_err() {
                return Err("interaction-date must be a calendar date YYYY-MM-DD".into());
            }
        }
        Ok(())
    }
}

pub fn nonblank(name: &str, value: &str) -> Result<()> {
    if value.trim().is_empty() {
        Err(format!("{name} must not be blank").into())
    } else {
        Ok(())
    }
}

pub fn validate_id(id: &str) -> Result<()> {
    let device = matches!(id, "con" | "prn" | "aux" | "nul")
        || id
            .strip_prefix("com")
            .or_else(|| id.strip_prefix("lpt"))
            .is_some_and(|suffix| suffix.len() == 1 && matches!(suffix.as_bytes()[0], b'1'..=b'9'));
    if id.is_empty()
        || id.len() > 64
        || !id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
        || device
    {
        Err("id must contain 1..64 lowercase ASCII letters, digits, '-' or '_'; Windows device names are reserved".into())
    } else {
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum Record {
    Live {
        schema_version: u32,
        id: String,
        revision: u64,
        recorded_at_ms: u64,
        interaction: Box<Interaction>,
    },
    Deleted {
        schema_version: u32,
        id: String,
        revision: u64,
    },
}

impl Record {
    pub fn id(&self) -> &str {
        match self {
            Self::Live { id, .. } | Self::Deleted { id, .. } => id,
        }
    }

    pub fn revision(&self) -> u64 {
        match self {
            Self::Live { revision, .. } | Self::Deleted { revision, .. } => *revision,
        }
    }

    pub fn validate(&self, expected_id: &str) -> Result<()> {
        validate_id(self.id())?;
        let version = match self {
            Self::Live {
                schema_version,
                interaction,
                recorded_at_ms,
                ..
            } => {
                interaction.validate()?;
                time::OffsetDateTime::from_unix_timestamp_nanos(
                    i128::from(*recorded_at_ms) * 1_000_000,
                )
                .map_err(|_| Error::from("invalid recording timestamp"))?;
                schema_version
            }
            Self::Deleted {
                schema_version,
                revision,
                ..
            } => {
                if *revision < 2 {
                    return Err("invalid deletion revision".into());
                }
                schema_version
            }
        };
        if *version != 1 || self.id() != expected_id || self.revision() == 0 {
            return Err(format!("invalid schema, ID or revision in record {expected_id}").into());
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Focus,
    Later,
    None,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Mark {
    pub revision: u64,
    pub state: State,
}

#[derive(Default)]
pub struct Changes {
    pub material: Option<String>,
    pub actor: Option<String>,
    pub details: Details,
    pub clear: Vec<String>,
}

impl Changes {
    pub fn apply(self, interaction: &mut Interaction) -> Result<()> {
        if let Some(value) = self.material {
            interaction.material = value;
        }
        if let Some(value) = self.actor {
            interaction.actor = value;
        }
        let pairs = [
            (
                "original",
                self.details.original,
                &mut interaction.details.original,
            ),
            (
                "interaction-date",
                self.details.interaction_date,
                &mut interaction.details.interaction_date,
            ),
            (
                "action",
                self.details.action,
                &mut interaction.details.action,
            ),
            (
                "portion",
                self.details.portion,
                &mut interaction.details.portion,
            ),
            (
                "context",
                self.details.context,
                &mut interaction.details.context,
            ),
            ("note", self.details.note, &mut interaction.details.note),
            (
                "artifact",
                self.details.artifact,
                &mut interaction.details.artifact,
            ),
        ];
        for (name, value, field) in pairs {
            if self.clear.iter().any(|s| s == name) {
                if value.is_some() {
                    return Err(format!("cannot set and clear {name} together").into());
                }
                *field = None;
            } else if value.is_some() {
                *field = value;
            }
        }
        interaction.validate()
    }
}
