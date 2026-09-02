use std::sync::LazyLock;

use scraper::{Html, Selector};

use crate::error::{Error, Result};

/// A single Cambridge Dictionary lookup result.
#[derive(Debug, Clone, PartialEq)]
pub struct CambridgeLookup {
    /// The headword (as displayed on the page).
    pub word: String,
    /// British English IPA pronunciation (e.g. "/həˈləʊ/").
    pub uk_ipa: Option<String>,
    /// Full HTTPS URL to the British English audio file (.mp3).
    pub uk_audio: Option<String>,
    /// American English IPA pronunciation (e.g. "/həˈloʊ/").
    pub us_ipa: Option<String>,
    /// Full HTTPS URL to the American English audio file (.mp3).
    pub us_audio: Option<String>,
    /// One or more definition senses.
    pub senses: Vec<Sense>,
}

/// A single definition sense with associated examples.
#[derive(Debug, Clone, PartialEq)]
pub struct Sense {
    /// Part(s) of speech (e.g. "exclamation, noun").
    pub part_of_speech: String,
    /// The plain-text definition.
    pub definition: String,
    /// Example sentences illustrating this sense.
    pub examples: Vec<String>,
    /// CEFR level if available (e.g. "A1", "B2").
    pub cefr_level: Option<String>,
}

// ─── Lazy-loaded CSS selectors (compiled once at first use) ───────────────

struct CssSelectors {
    entry_body: Selector,
    headword: Selector,
    pos: Selector,
    ipa: Selector,
    pos_header: Selector,
    uk_audio: Selector,
    us_audio: Selector,
    def_block: Selector,
    definition: Selector,
    example: Selector,
    cefr: Selector,
}

static SEL: LazyLock<CssSelectors> = LazyLock::new(|| CssSelectors {
    entry_body: Selector::parse(".entry-body").expect(".entry-body"),
    headword:   Selector::parse(".hw.dhw").expect(".hw.dhw"),
    pos:        Selector::parse(".pos.dpos").expect(".pos.dpos"),
    ipa:        Selector::parse(".ipa.dipa").expect(".ipa.dipa"),
    pos_header: Selector::parse(".pos-header.dpos-h").expect(".pos-header"),
    uk_audio:   Selector::parse(".uk.dpron-i source[type='audio/mpeg']")
                    .expect("uk audio source"),
    us_audio:   Selector::parse(".us.dpron-i source[type='audio/mpeg']")
                    .expect("us audio source"),
    def_block:  Selector::parse(".def-block.ddef_block").expect(".def-block.ddef_block"),
    definition: Selector::parse(".def.ddef_d.db").expect(".def.ddef_d.db"),
    example:    Selector::parse(".eg").expect(".eg"),
    cefr:       Selector::parse(".dxref").expect(".dxref"),
});

// ─── Public API ───────────────────────────────────────────────────────────

/// Parse Cambridge Dictionary HTML and return the extracted data.
///
/// The function expects the full HTML of a page like
/// `https://dictionary.cambridge.org/dictionary/english/<word>`.
///
/// # Errors
///
/// - [`Error::WordNotFound`] — no `.entry-body` could be found (word not in dictionary).
/// - [`Error::PayloadNotFound`] — entry body found but no headword extracted.
/// - [`Error::NoDefinitions`] — entry found but contained no text definitions.
pub fn scrape_cambridge_html(html: &str) -> Result<CambridgeLookup> {
    let document = Html::parse_document(html);

    // Bail early if the page doesn't contain a dictionary entry.
    document
        .select(&SEL.entry_body)
        .next()
        .ok_or(Error::WordNotFound)?;

    // ── Headword ──────────────────────────────────────────────────────
    let word = document
        .select(&SEL.headword)
        .next()
        .map(|el| flatten_text(&el))
        .ok_or(Error::PayloadNotFound)?;

    // ── Part(s) of speech ─────────────────────────────────────────────
    let pos: Vec<String> = document
        .select(&SEL.pos)
        .map(|el| flatten_text(&el))
        .filter(|s| !s.is_empty())
        .collect();
    let part_of_speech = pos.join(", ");

    // ── Pronunciation ─────────────────────────────────────────────────
    // sibling combinators (+ / ~) are unreliable in scraper 0.14, so we
    // walk the pos-header children manually to pair .pron with preceding
    // .uk / .us elements.
    let (uk_ipa, us_ipa) = extract_pronunciation(&document);

    let uk_audio = document
        .select(&SEL.uk_audio)
        .next()
        .and_then(|el| el.value().attr("src"))
        .map(|src| format!("https://dictionary.cambridge.org{src}"));

    let us_audio = document
        .select(&SEL.us_audio)
        .next()
        .and_then(|el| el.value().attr("src"))
        .map(|src| format!("https://dictionary.cambridge.org{src}"));

    // ── Definition senses ─────────────────────────────────────────────
    let mut senses: Vec<Sense> = Vec::new();

    for block in document.select(&SEL.def_block) {
        let definition = block
            .select(&SEL.definition)
            .next()
            .map(|el| flatten_text(&el))
            .unwrap_or_default();

        if definition.is_empty() {
            continue;
        }

        let examples: Vec<String> = block
            .select(&SEL.example)
            .map(|el| flatten_text(&el))
            .filter(|s| !s.is_empty())
            .collect();

        let cefr_level = block
            .select(&SEL.cefr)
            .next()
            .map(|el| flatten_text(&el))
            .filter(|s| !s.is_empty());

        senses.push(Sense {
            part_of_speech: part_of_speech.clone(),
            definition,
            examples,
            cefr_level,
        });
    }

    if senses.is_empty() {
        return Err(Error::NoDefinitions);
    }

    Ok(CambridgeLookup {
        word,
        uk_ipa,
        uk_audio,
        us_ipa,
        us_audio,
        senses,
    })
}

/// Walk the pos-header children to pair `.pron` IPA with preceding `.uk` / `.us` markers.
fn extract_pronunciation(document: &Html) -> (Option<String>, Option<String>) {
    let header = match document.select(&SEL.pos_header).next() {
        Some(h) => h,
        None => return (None, None),
    };

    let mut uk = None;
    let mut us = None;

    fn ipa_text(el: &scraper::ElementRef) -> Option<String> {
        el.children()
            .filter_map(|c| {
                let el = c.value().as_element()?;
                if el.attr("class").unwrap_or("").contains("ipa") {
                    Some(
                        el.text()
                            .collect::<Vec<_>>()
                            .join("")
                            .trim()
                            .to_string(),
                    )
                } else {
                    None
                }
            })
            .next()
    }

    fn ipa_in_region(el: &scraper::ElementRef) -> Option<String> {
        for child in el.children() {
            let c_el = match child.value().as_element() {
                Some(e) => e,
                None => continue,
            };
            if c_el.attr("class").unwrap_or("").contains("pron dpron")
                || c_el.attr("class").unwrap_or("").contains("dpron pron")
            {
                if let Some(er) = scraper::ElementRef::wrap(child) {
                    return ipa_text(&er);
                }
            }
        }
        None
    }

    for child in header.children() {
        let child_el = match child.value().as_element() {
            Some(el) => el,
            None => continue,
        };
        let cls = child_el.attr("class").unwrap_or("");

        if (cls.contains("dpron-i uk") || cls.contains("uk dpron-i")) && uk.is_none() {
            if let Some(er) = scraper::ElementRef::wrap(child) {
                uk = ipa_in_region(&er);
            }
        } else if (cls.contains("dpron-i us") || cls.contains("us dpron-i")) && us.is_none() {
            if let Some(er) = scraper::ElementRef::wrap(child) {
                us = ipa_in_region(&er);
            }
        } else if cls.contains("pron dpron") || cls.contains("dpron pron") {
            // Old format: .pron.dpron is a direct sibling (no .uk/.us wrapper)
            if let Some(er) = scraper::ElementRef::wrap(child) {
                let t = ipa_text(&er);
                if uk.is_none() {
                    uk = t;
                } else if us.is_none() {
                    us = t;
                }
            }
        }
    }

    (uk, us)
}
            }
        }
    }

    (uk, us)
}

/// Extract the `<title>` text from the page (best-effort).
pub fn extract_title(html: &str) -> String {
    let document = Html::parse_document(html);
    let title_sel = Selector::parse("title").expect("title");
    document
        .select(&title_sel)
        .next()
        .map(|el| {
            let text = el.text().collect::<Vec<_>>().concat();
            // Strip trailing " | English meaning - Cambridge Dictionary"
            if let Some(idx) = text.find(" | ") {
                text[..idx].to_string()
            } else {
                text
            }
        })
        .unwrap_or_default()
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/// Join all descendant text nodes, normalise whitespace, and trim.
fn flatten_text(el: &scraper::ElementRef) -> String {
    el.text()
        .collect::<Vec<_>>()
        .concat()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

// ─── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal synthetic HTML mimicking the Cambridge entry structure for "hello".
    fn sample_html() -> String {
        format!(
            r#"<!DOCTYPE html>
<html><head><title>hello | English meaning - Cambridge Dictionary</title></head>
<body>
<div class="di-body"><div class="entry"><div class="entry-body">
  <div class="pos-header dpos-h">
    <div class="di-title">
      <span class="headword hdb tw-bw dhw dpos-h_hw">
        <span class="hw dhw">hello</span>
      </span>
    </div>
    <div class="posgram dpos-g hdib lmr-5">
      <span class="pos dpos">exclamation</span>,
      <span class="pos dpos">noun</span>
    </div>
    <span class="uk dpron-i">
      <audio class="hdn" preload="none" id="audio1">
        <source type="audio/mpeg" src="/media/english/uk_pron/u/ukh/ukhef/ukheft_029.mp3"/>
      </audio>
      <div class="i i-volume-up" onclick="audio1.play();"></div>
    </span>
    <span class="pron dpron">/<span class="ipa dipa">həˈləʊ</span>/</span>
    <span class="us dpron-i">
      <audio class="hdn" preload="none" id="audio2">
        <source type="audio/mpeg" src="/media/english/us_pron/h/hel/hello/hello.mp3"/>
      </audio>
      <div class="i i-volume-up" onclick="audio2.play();"></div>
    </span>
    <span class="pron dpron">/<span class="ipa dipa">həˈloʊ</span>/</span>
  </div>
  <div class="pos-body">
    <div class="def-block ddef_block">
      <div class="ddef_h">
        <span class="def-info ddef-info"><span class="epp-xref dxref A1">A1</span></span>
        <div class="def ddef_d db">used when meeting or greeting someone:</div>
      </div>
      <div class="def-body ddef_b">
        <div class="examp dexamp">
          <span class="eg deg">Hello, Paul. I haven't seen you for ages.</span>
        </div>
        <div class="examp dexamp">
          <span class="eg deg">I know her vaguely.</span>
        </div>
      </div>
    </div>
    <div class="def-block ddef_block">
      <div class="ddef_h">
        <span class="def-info ddef-info"><span class="epp-xref dxref A1">A1</span></span>
        <div class="def ddef_d db">something that is said at the beginning of a phone conversation:</div>
      </div>
      <div class="def-body ddef_b">
        <div class="examp dexamp">
          <span class="eg deg">"Hello, I'd like some information please."</span>
        </div>
      </div>
    </div>
  </div>
</div></div></div>
</body></html>"#
        )
    }

    #[test]
    fn parses_basic_entry() {
        let result = scrape_cambridge_html(&sample_html()).unwrap();
        assert_eq!(result.word, "hello");
        assert_eq!(result.uk_ipa.as_deref(), Some("həˈləʊ"));
        assert_eq!(result.us_ipa.as_deref(), Some("həˈloʊ"));
        assert_eq!(
            result.uk_audio.as_deref(),
            Some("https://dictionary.cambridge.org/media/english/uk_pron/u/ukh/ukhef/ukheft_029.mp3")
        );
        assert_eq!(
            result.us_audio.as_deref(),
            Some("https://dictionary.cambridge.org/media/english/us_pron/h/hel/hello/hello.mp3")
        );
    }

    #[test]
    fn parses_senses() {
        let result = scrape_cambridge_html(&sample_html()).unwrap();
        assert_eq!(result.senses.len(), 2);

        assert_eq!(result.senses[0].definition, "used when meeting or greeting someone:");
        assert_eq!(result.senses[0].examples.len(), 2);
        assert_eq!(
            result.senses[0].examples[0],
            "Hello, Paul. I haven't seen you for ages."
        );
        assert_eq!(result.senses[0].cefr_level.as_deref(), Some("A1"));

        assert_eq!(
            result.senses[1].definition,
            "something that is said at the beginning of a phone conversation:"
        );
        assert_eq!(result.senses[1].examples.len(), 1);
        assert_eq!(result.senses[1].cefr_level.as_deref(), Some("A1"));
    }

    #[test]
    fn pos_joined() {
        let result = scrape_cambridge_html(&sample_html()).unwrap();
        assert_eq!(result.senses[0].part_of_speech, "exclamation, noun");
    }

    #[test]
    fn errors_on_missing_entry() {
        let html = "<html><body>nothing here</body></html>";
        assert!(matches!(
            scrape_cambridge_html(html),
            Err(Error::WordNotFound)
        ));
    }

    #[test]
    fn extracts_title() {
        assert_eq!(
            extract_title(&sample_html()),
            "hello"
        );
    }
}
