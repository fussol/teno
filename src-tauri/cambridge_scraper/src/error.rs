use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("the word was not found in Cambridge Dictionary")]
    WordNotFound,

    #[error("could not locate a Cambridge Dictionary entry in the provided HTML")]
    PayloadNotFound,

    #[error("no definitions found for this word")]
    NoDefinitions,

    #[error("JSON decode error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("regex error: {0}")]
    Regex(#[from] regex::Error),
}

pub type Result<T> = std::result::Result<T, Error>;
