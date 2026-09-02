use std::sync::LazyLock;

use scraper::{Html, Selector};

use crate::error::{Error, Result};
use crate::shared::{audio_src, flatten_text};

// ── Data model ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ChineseLookup {
    pub word: String,
    pub uk_ipa: Option<String>,
    pub uk_audio: Option<String>,
    pub us_ipa: Option<String>,
    pub us_audio: Option<String>,
    pub senses: Vec<ChineseSense>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ChineseSense {
    pub part_of_speech: String,
    pub definition: String,
    pub translation: String,
    pub examples: Vec<ChineseExample>,
    pub cefr_level: Option<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ChineseExample {
    pub english: String,
    pub chinese: String,
}

// ── Selectors ─────────────────────────────────────────────────────────────

struct CssSel {
    entry_body: Selector,
    headword: Selector,
    pos: Selector,
    uk_audio: Selector,
    us_audio: Selector,
    pr_section: Selector,
    pos_body: Selector,
    def_block: Selector,
    definition: Selector,
    cefr: Selector,
    trans: Selector,
    eg_examp: Selector,
    trans_examp: Selector,
}

/// For the Chinese page, `.pron.dpron` is a CHILD of `.uk.dpron-i` / `.us.dpron-i`,
/// so we use a simple flat selector for all IPA and pair them by order (first = UK, second = US).
static IPA_SEL: LazyLock<Selector> =
    LazyLock::new(|| Selector::parse(".ipa.dipa").unwrap());

static SEL: LazyLock<CssSel> = LazyLock::new(|| CssSel {
    entry_body: Selector::parse(".entry-body").unwrap(),
    headword:   Selector::parse(".hw.dhw").unwrap(),
    pos:        Selector::parse(".pos.dpos").unwrap(),
    uk_audio:   Selector::parse(".uk.dpron-i source[type='audio/mpeg']").unwrap(),
    us_audio:   Selector::parse(".us.dpron-i source[type='audio/mpeg']").unwrap(),
    pr_section: Selector::parse(".pr.entry-body__el").unwrap(),
    pos_body:   Selector::parse(".pos-body").unwrap(),
    def_block:  Selector::parse(".def-block.ddef_block").unwrap(),
    definition: Selector::parse(".def.ddef_d.db").unwrap(),
    cefr:       Selector::parse(".dxref").unwrap(),
    trans:      Selector::parse(".trans.dtrans").unwrap(),
    // Within an .examp.dexamp, find the English example and Chinese translation
    eg_examp:   Selector::parse(".eg.deg").unwrap(),
    trans_examp: Selector::parse(".trans.dtrans.hdb").unwrap(),
});

// ── Public API ────────────────────────────────────────────────────────────

pub fn scrape_cambridge_chinese_html(html: &str) -> Result<ChineseLookup> {
    let document = Html::parse_document(html);

    document
        .select(&SEL.entry_body)
        .next()
        .ok_or(Error::WordNotFound)?;

    let word = document
        .select(&SEL.headword)
        .next()
        .map(|el| flatten_text(&el))
        .ok_or(Error::PayloadNotFound)?;

    let (uk_ipa, us_ipa) = extract_ipa(&document);

    let uk_audio = audio_src(&document, &SEL.uk_audio);
    let us_audio = audio_src(&document, &SEL.us_audio);

    let mut senses = Vec::new();

    for entry in document.select(&SEL.entry_body) {
        let section = match entry.select(&SEL.pr_section).next() {
            Some(s) => s,
            None => continue,
        };

        let pos: Vec<String> = section
            .select(&SEL.pos)
            .map(|e| flatten_text(&e))
            .filter(|s| !s.is_empty())
            .collect();
        let current_pos = pos.join(", ");

        let body = match section.select(&SEL.pos_body).next() {
            Some(b) => b,
            None => continue,
        };

        for block in body.select(&SEL.def_block) {
            let definition = block
                .select(&SEL.definition)
                .next()
                .map(|el| flatten_text(&el))
                .unwrap_or_default();

            if definition.is_empty() {
                continue;
            }

            let translation = block
                .select(&SEL.trans)
                .next()
                .map(|el| flatten_text(&el))
                .unwrap_or_default();

            let mut examples = Vec::new();
            for examp in block.select(&Selector::parse(".examp.dexamp").unwrap()) {
                let english = examp
                    .select(&SEL.eg_examp)
                    .next()
                    .map(|el| flatten_text(&el))
                    .unwrap_or_default();

                let chinese = examp
                    .select(&SEL.trans_examp)
                    .next()
                    .map(|el| flatten_text(&el))
                    .unwrap_or_default();

                if !english.is_empty() {
                    examples.push(ChineseExample { english, chinese });
                }
            }

            let cefr_level = block
                .select(&SEL.cefr)
                .next()
                .map(|el| flatten_text(&el))
                .filter(|s| !s.is_empty());

            senses.push(ChineseSense {
                part_of_speech: current_pos.clone(),
                definition,
                translation,
                examples,
                cefr_level,
            });
        }
    }

    if senses.is_empty() {
        return Err(Error::NoDefinitions);
    }

    Ok(ChineseLookup {
        word,
        uk_ipa,
        uk_audio,
        us_ipa,
        us_audio,
        senses,
    })
}

// ── IPA extraction (Chinese page: .pron is CHILD of .uk / .us) ────────────
// Both .uk.dpron-i and .us.dpron-i contain .pron.dpron .ipa.dipa as children.
// We grab ALL .ipa.dipa within the first pos-header and pair by document order.

fn extract_ipa(document: &Html) -> (Option<String>, Option<String>) {
    let header_sel = Selector::parse(".pos-header.dpos-h").unwrap();
    let header = match document.select(&header_sel).next() {
        Some(h) => h,
        None => return (None, None),
    };

    let mut ipas = header.select(&IPA_SEL).filter_map(|el| {
        let t = flatten_text(&el);
        if t.is_empty() { None } else { Some(t) }
    });

    let uk = ipas.next();
    let us = ipas.next();
    (uk, us)
}

// ─── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_html() -> String {
        r#"<!DOCTYPE html>
<html lang="zh-Hant"><head><title>hello中文(繁體)翻譯：劍橋詞典</title></head>
<body>
<div class="di-body"><div class="entry">
<div class="entry-body">
  <div class="pr entry-body__el">
    <div class="pos-header dpos-h">
      <div class="di-title">
        <span class="headword"><span class="hw dhw">hello</span></span>
      </div>
      <div class="posgram dpos-g">
        <span class="pos dpos">exclamation</span>,
        <span class="pos dpos">noun</span>
      </div>
      <span class="uk dpron-i">
        <span class="region dreg">uk</span>
        <span class="daud">
          <audio><source type="audio/mpeg" src="/media/english/uk_pron/u/ukh/ukhef_029.mp3"/></audio>
        </span>
        <span class="pron dpron">/<span class="ipa dipa">həˈləʊ</span>/</span>
      </span>
      <span class="us dpron-i">
        <span class="region dreg">us</span>
        <span class="daud">
          <audio><source type="audio/mpeg" src="/media/english/us_pron/h/hel/hello.mp3"/></audio>
        </span>
        <span class="pron dpron">/<span class="ipa dipa">həˈloʊ</span>/</span>
      </span>
    </div>
    <div class="pos-body">
      <div class="pr dsense">
        <div class="sense-body dsense_b">
          <div class="def-block ddef_block">
            <div class="ddef_h">
              <span class="def-info"><span class="epp-xref dxref A1">A1</span></span>
              <div class="def ddef_d db">used when meeting or greeting someone:</div>
            </div>
            <div class="def-body ddef_b">
              <span class="trans dtrans dtrans-se break-cj" lang="zh-Hant">
                <span class="dtrans">喂</span>，<span class="dtrans">你好</span>（用於問候或打招呼）
              </span>
              <div class="examp dexamp">
                <span class="eg deg">Hello, Paul. I haven't seen you for ages.</span>
                <span class="trans dtrans dtrans-se hdb break-cj" lang="zh-Hant">「你好，保羅。好久不見了。」</span>
              </div>
              <div class="examp dexamp">
                <span class="eg deg">I know her vaguely.</span>
                <span class="trans dtrans dtrans-se hdb break-cj" lang="zh-Hant">「我依稀認識她。」</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
</div></div>
</body></html>"#
        .to_string()
    }

    #[test]
    fn parses_basic_entry() {
        let r = scrape_cambridge_chinese_html(&sample_html()).unwrap();
        assert_eq!(r.word, "hello");
        assert_eq!(r.uk_ipa.as_deref(), Some("həˈləʊ"));
        assert_eq!(r.us_ipa.as_deref(), Some("həˈloʊ"));
        assert!(r.uk_audio.is_some());
        assert!(r.us_audio.is_some());
    }

    #[test]
    fn parses_translation() {
        let r = scrape_cambridge_chinese_html(&sample_html()).unwrap();
        assert_eq!(r.senses.len(), 1);
        assert_eq!(r.senses[0].translation, "喂，你好（用於問候或打招呼）");
        assert_eq!(r.senses[0].cefr_level.as_deref(), Some("A1"));
        assert_eq!(r.senses[0].part_of_speech, "exclamation, noun");
    }

    #[test]
    fn parses_examples_with_translations() {
        let r = scrape_cambridge_chinese_html(&sample_html()).unwrap();
        assert_eq!(r.senses[0].examples.len(), 2);
        assert_eq!(r.senses[0].examples[0].english, "Hello, Paul. I haven't seen you for ages.");
        assert_eq!(r.senses[0].examples[0].chinese, "「你好，保羅。好久不見了。」");
        assert_eq!(r.senses[0].examples[1].english, "I know her vaguely.");
        assert_eq!(r.senses[0].examples[1].chinese, "「我依稀認識她。」");
    }

    #[test]
    fn errors_on_missing_entry() {
        assert!(matches!(
            scrape_cambridge_chinese_html("<html></html>"),
            Err(Error::WordNotFound)
        ));
    }
}
