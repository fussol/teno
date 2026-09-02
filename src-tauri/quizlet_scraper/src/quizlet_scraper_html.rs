//! Pure-HTML Quizlet scraper.
//!
//! This module performs **no network I/O**. Give it a string containing
//! a Quizlet flashcard page's HTML and it will return the extracted
//! term/definition pairs.
//!
//! See [`scrape_quizlet_html`] for the public entry point.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::error::{Error, Result};

/// A single flashcard: a term and its definition.
///
/// Both fields are plain text — rich-text markup, images, and audio are
/// intentionally stripped during extraction.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Flashcard {
    /// The "word" side of the card.
    pub term: String,
    /// The "definition" side of the card.
    pub definition: String,
}

/// `window.Quizlet["setPageData|assistantModeData|cardsModeData"] = <JSON>; QLoad(...)` blocks.
static QUIZLET_BLOCK_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    ["setPageData", "assistantModeData", "cardsModeData"]
        .iter()
        .map(|key| {
            Regex::new(&format!(
                r#"window\.Quizlet\["{key}"\]\s*=\s*(.+?);\s*QLoad\("Quizlet\.{key}"\);"#,
            ))
            .expect("regex compiles")
        })
        .collect()
});

/// Older Next.js SSR fallback: `dehydratedReduxStateKey":<JSON>},"__N_SSP`.
static DEHYDRATED_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"dehydratedReduxStateKey":(.+?)},"__N_SSP"#).expect("regex compiles")
});

/// Standard Next.js `__NEXT_DATA__` script tag — the primary entry point
/// on current Quizlet pages.
static NEXT_DATA_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"<script id="__NEXT_DATA__"[^>]*>(.*?)</script>"#).expect("regex compiles")
});

/// HTML `<title>` tag extractor for deck title display.
static TITLE_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)<title[^>]*>(.+?)</title>").expect("regex compiles")
});

/// Naive HTML tag stripper for rich-text fallback.
static HTML_TAG_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<[^>]+>").expect("regex compiles"));

/// Extract every term/definition pair from a Quizlet flashcard page's HTML.
///
/// The function tries several known embed patterns in order, from most
/// modern to most legacy:
///
/// 1. `<script id="__NEXT_DATA__">` (current Quizlet layout) — the
///    `studiableItems` array lives inside a doubly-encoded
///    `dehydratedReduxStateKey` string.
/// 2. `window.Quizlet["setPageData" | "assistantModeData" | "cardsModeData"]`
///    blocks (legacy layouts).
/// 3. Raw `dehydratedReduxStateKey":<JSON>},"__N_SSP` regex fallback.
///
/// # Errors
///
/// - [`Error::PayloadNotFound`] — none of the patterns matched.
/// - [`Error::NoTextCards`] — a payload was found but contained no text cards.
/// - [`Error::Json`] — a payload matched but could not be decoded.
pub fn scrape_quizlet_html(html: &str) -> Result<Vec<Flashcard>> {
    let items = find_studiable_items(html)?;

    let cards = map_items(&items);
    if cards.is_empty() {
        return Err(Error::NoTextCards);
    }
    Ok(cards)
}

/// Best-effort extraction of the deck title from the page's `<title>` tag.
///
/// Returns an empty string if no title can be found.
pub fn extract_title(html: &str) -> String {
    let Some(caps) = TITLE_PATTERN.captures(html) else {
        return String::new();
    };
    let mut title = caps.get(1).map(|m| m.as_str()).unwrap_or("").to_string();
    // Strip common Quizlet suffixes / prefixes.
    if let Some(idx) = title.rfind("| Quizlet") {
        title.truncate(idx);
    }
    if let Some(stripped) = title.strip_prefix("Flashcards ") {
        title = stripped.to_string();
    }
    title.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Try every known embed pattern and return the first `studiableItems`
/// array we can decode.
fn find_studiable_items(html: &str) -> Result<Vec<Value>> {
    if let Some(items) = try_next_data(html) {
        return Ok(items);
    }

    for re in QUIZLET_BLOCK_PATTERNS.iter() {
        if let Some(items) = try_block_pattern(html, re) {
            return Ok(items);
        }
    }

    if let Some(items) = try_dehydrated_regex(html) {
        return Ok(items);
    }

    Err(Error::PayloadNotFound)
}

/// Parse `__NEXT_DATA__` as JSON, then look for any string field whose value
/// (when re-parsed) contains `studiableItems`.
fn try_next_data(html: &str) -> Option<Vec<Value>> {
    let caps = NEXT_DATA_PATTERN.captures(html)?;
    let next_data: Value = serde_json::from_str(caps.get(1)?.as_str()).ok()?;

    // studiableItems lives inside a doubly-encoded JSON string — collect every
    // string that mentions it and try to decode each one.
    for candidate in find_strings_containing(&next_data, "studiableItems") {
        if let Ok(inner) = serde_json::from_str::<Value>(&candidate) {
            if let Some(items) = extract_studiable_items(&inner) {
                return Some(items);
            }
        }
    }
    None
}

/// `window.Quizlet["xxx"] = <JSON>; QLoad("Quizlet.xxx");`
fn try_block_pattern(html: &str, re: &Regex) -> Option<Vec<Value>> {
    let caps = re.captures(html)?;
    let raw = caps.get(1)?.as_str().trim();
    let payload: Value = serde_json::from_str(raw).ok()?;
    extract_studiable_items(&payload)
}

/// Raw `dehydratedReduxStateKey":<JSON>},"__N_SSP` fallback.
fn try_dehydrated_regex(html: &str) -> Option<Vec<Value>> {
    let caps = DEHYDRATED_PATTERN.captures(html)?;
    let raw = caps.get(1)?.as_str().trim();
    let outer: Value = serde_json::from_str(raw).ok()?;
    // The captured value may be a JSON-encoded string whose value is itself JSON.
    let payload = match &outer {
        Value::String(s) => serde_json::from_str::<Value>(s).ok()?,
        other => other.clone(),
    };
    extract_studiable_items(&payload)
}

/// Recursively collect every string value inside `payload` that contains
/// `needle`. Used to locate the doubly-encoded `dehydratedReduxStateKey`
/// string inside `__NEXT_DATA__`.
fn find_strings_containing(payload: &Value, needle: &str) -> Vec<String> {
    let mut found = Vec::new();
    match payload {
        Value::Object(map) => {
            for v in map.values() {
                found.extend(find_strings_containing(v, needle));
            }
        }
        Value::Array(arr) => {
            for v in arr {
                found.extend(find_strings_containing(v, needle));
            }
        }
        Value::String(s) if s.contains(needle) => found.push(s.clone()),
        _ => {}
    }
    found
}

/// Recursively search `payload` for the first `studiableItems` array and
/// return a clone of it.
fn extract_studiable_items(payload: &Value) -> Option<Vec<Value>> {
    match payload {
        Value::Object(map) => {
            if let Some(items) = map.get("studiableItems") {
                if let Some(arr) = items.as_array() {
                    if !arr.is_empty() {
                        return Some(arr.clone());
                    }
                }
            }
            for v in map.values() {
                if let Some(items) = extract_studiable_items(v) {
                    return Some(items);
                }
            }
            None
        }
        Value::Array(arr) => {
            for v in arr {
                if let Some(items) = extract_studiable_items(v) {
                    return Some(items);
                }
            }
            None
        }
        _ => None,
    }
}

/// Convert a list of `studiableItem` objects into a list of flashcards.
///
/// Each item has a `cardSides` array; we look for the side whose `label`
/// is `"word"` (the term) and the side whose `label` is `"definition"`.
/// Within each side, we pick the first `media` entry of `type == 1`
/// (text) and read its `plainText` field.
fn map_items(items: &[Value]) -> Vec<Flashcard> {
    items.iter().filter_map(map_single_item).collect()
}

fn map_single_item(item: &Value) -> Option<Flashcard> {
    let sides = item.get("cardSides")?.as_array()?;
    let mut term = None;
    let mut definition = None;

    for side in sides {
        let label = side.get("label")?.as_str()?;
        let media = side.get("media")?.as_array()?;
        let text = media
            .iter()
            .find(|m| m.get("type").and_then(Value::as_i64) == Some(1))
            .and_then(parse_text_item);
        let Some(text) = text else {
            continue;
        };
        match label {
            "word" => {
                term.get_or_insert(text);
            }
            "definition" => {
                definition.get_or_insert(text);
            }
            _ => {}
        }
    }

    Some(Flashcard {
        term: term?,
        definition: definition.unwrap_or_default(),
    })
}

/// Extract the text content of a `media` entry of type 1.
///
/// Prefers `plainText`; falls back to stripping HTML tags from `richText`
/// if `plainText` is missing or empty (some older decks only ship rich
/// text).
fn parse_text_item(media: &Value) -> Option<String> {
    let plain = media
        .get("plainText")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if !plain.is_empty() {
        return Some(plain);
    }

    let rich = media
        .get("richText")
        .and_then(Value::as_str)?
        .trim()
        .to_string();
    if rich.is_empty() {
        return None;
    }
    Some(strip_html(&rich))
}

/// Naive but allocation-friendly HTML tag stripper.
fn strip_html(input: &str) -> String {
    HTML_TAG_PATTERN.replace_all(input, "").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_doubly_encoded_next_data() {
        // Minimal synthetic payload mimicking the modern Quizlet layout:
        // __NEXT_DATA__ -> props.pageProps.dehydratedReduxStateKey (string)
        // -> { studiableItems: [...] }
        let inner = serde_json::json!({
            "studiableItems": [
                {
                    "cardSides": [
                        {
                            "label": "word",
                            "media": [
                                {"type": 1, "plainText": "hello"}
                            ]
                        },
                        {
                            "label": "definition",
                            "media": [
                                {"type": 1, "plainText": "a greeting"}
                            ]
                        }
                    ]
                }
            ]
        });
        let inner_str = serde_json::to_string(&inner).unwrap();
        let next_data = serde_json::json!({
            "props": {
                "pageProps": {
                    "dehydratedReduxStateKey": inner_str
                }
            }
        });
        let html = format!(
            r#"<html><head><title>Test | Quizlet</title></head><body>
            <script id="__NEXT_DATA__" type="application/json">{}</script>
            </body></html>"#,
            serde_json::to_string(&next_data).unwrap()
        );

        let cards = scrape_quizlet_html(&html).unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].term, "hello");
        assert_eq!(cards[0].definition, "a greeting");
        assert_eq!(extract_title(&html), "Test");
    }

    #[test]
    fn parses_legacy_block_pattern() {
        let payload = serde_json::json!({
            "studiableDocumentData": {
                "studiableItems": [
                    {
                        "cardSides": [
                            {"label": "word", "media": [{"type": 1, "plainText": "cat"}]},
                            {"label": "definition", "media": [{"type": 1, "plainText": "a small feline"}]}
                        ]
                    }
                ]
            }
        });
        let html = format!(
            r#"<html><body>
            <script>window.Quizlet["setPageData"] = {}; QLoad("Quizlet.setPageData");</script>
            </body></html>"#,
            serde_json::to_string(&payload).unwrap()
        );

        let cards = scrape_quizlet_html(&html).unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].term, "cat");
        assert_eq!(cards[0].definition, "a small feline");
    }

    #[test]
    fn returns_error_when_no_payload() {
        let html = "<html><body>nothing here</body></html>";
        assert!(matches!(
            scrape_quizlet_html(html),
            Err(Error::PayloadNotFound)
        ));
    }

    #[test]
    fn skips_image_only_cards() {
        let payload = serde_json::json!({
            "studiableItems": [
                {
                    "cardSides": [
                        {"label": "word", "media": [{"type": 1, "plainText": "shape"}]},
                        {"label": "definition", "media": [{"type": 2, "url": "https://x/shape.png"}]}
                    ]
                }
            ]
        });
        let html = format!(
            r#"<script>window.Quizlet["setPageData"] = {}; QLoad("Quizlet.setPageData");</script>"#,
            serde_json::to_string(&payload).unwrap()
        );
        let cards = scrape_quizlet_html(&html).unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].term, "shape");
        assert_eq!(cards[0].definition, "");
    }
}
