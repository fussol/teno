//! URL helpers.

use crate::error::{Error, Result};

/// Extract the numeric deck ID from a Quizlet URL.
///
/// ```rust
/// # use quizlet_scraper::extract_deck_id;
/// assert_eq!(
///     extract_deck_id("https://quizlet.com/tw/585509926/some-slug-flash-cards/").unwrap(),
///     "585509926",
/// );
/// ```
pub fn extract_deck_id(url: &str) -> Result<String> {
    let parsed = url::Url::parse(url).map_err(|_| Error::InvalidDeckUrl(url.to_string()))?;
    let segments = parsed
        .path_segments()
        .ok_or_else(|| Error::InvalidDeckUrl(url.to_string()))?;

    for seg in segments {
        if seg.chars().all(|c| c.is_ascii_digit()) && !seg.is_empty() {
            return Ok(seg.to_string());
        }
    }
    Err(Error::InvalidDeckUrl(url.to_string()))
}

/// Build the canonical flashcards URL for a deck ID.
///
/// Quizlet accepts both `/tw/<id>/...` and `/<id>/flashcards`; we use
/// the latter because it is locale-independent and consistently returns
/// the embedded JSON payload.
pub fn build_flashcards_url(deck_id: &str) -> String {
    format!("https://quizlet.com/{deck_id}/flashcards")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_deck_id_from_locale_url() {
        let id = extract_deck_id(
            "https://quizlet.com/tw/585509926/some-slug-flash-cards/",
        )
        .unwrap();
        assert_eq!(id, "585509926");
    }

    #[test]
    fn extracts_deck_id_from_flashcards_url() {
        let id = extract_deck_id("https://quizlet.com/585509926/flashcards").unwrap();
        assert_eq!(id, "585509926");
    }

    #[test]
    fn extracts_deck_id_from_bare_url() {
        let id = extract_deck_id("https://quizlet.com/585509926").unwrap();
        assert_eq!(id, "585509926");
    }

    #[test]
    fn rejects_non_quizlet_url() {
        assert!(extract_deck_id("not a url").is_err());
        assert!(extract_deck_id("https://example.com/no/numbers").is_err());
    }

    #[test]
    fn builds_flashcards_url() {
        assert_eq!(
            build_flashcards_url("12345"),
            "https://quizlet.com/12345/flashcards"
        );
    }
}
