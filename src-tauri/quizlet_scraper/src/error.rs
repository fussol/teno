//! Error types.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    /// The HTML did not contain any of the known Quizlet embed patterns,
    /// or the embedded JSON could not be decoded.
    #[error("could not locate a Quizlet flashcard payload in the provided HTML")]
    PayloadNotFound,

    /// A payload was found but contained no text term/definition cards
    /// (e.g. an image-only deck).
    #[error("payload contained no text term/definition cards")]
    NoTextCards,

    /// The supplied URL does not look like a Quizlet set URL.
    #[error("could not extract a deck ID from URL: {0}")]
    InvalidDeckUrl(String),

    /// A JSON decoding failure while parsing the embedded payload.
    #[error("JSON decode error: {0}")]
    Json(#[from] serde_json::Error),

    /// A regex compilation failure (should never happen at runtime —
    /// all patterns are compiled once via `LazyLock`).
    #[error("regex error: {0}")]
    Regex(#[from] regex::Error),
}

pub type Result<T> = std::result::Result<T, Error>;
