use std::sync::LazyLock;

use scraper::{Html, Selector};

use crate::error::{Error, Result};
use crate::shared::{audio_src, flatten_text};

// ── Data model ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct EnglishLookup {
    pub word: String,
    pub uk_ipa: Option<String>,
    pub uk_audio: Option<String>,
    pub us_ipa: Option<String>,
    pub us_audio: Option<String>,
    pub senses: Vec<Sense>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct Sense {
    pub part_of_speech: String,
    pub definition: String,
    pub examples: Vec<String>,
    pub cefr_level: Option<String>,
}

// ── Selectors ─────────────────────────────────────────────────────────────

struct CssSel {
    entry_body: Selector,
    headword: Selector,
    headword_new: Selector, // F13-SR2: 新模板 h2.headword
    pos: Selector,
    pos_header: Selector,
    pr_section: Selector,
    pos_body: Selector,
    uk_audio: Selector,
    us_audio: Selector,
    def_block: Selector,
    definition: Selector,
    example: Selector,
    cefr: Selector,
}

static SEL: LazyLock<CssSel> = LazyLock::new(|| CssSel {
    entry_body: Selector::parse(".entry-body").unwrap(),
    headword:   Selector::parse(".hw.dhw").unwrap(),
    headword_new: Selector::parse(".headword").unwrap(), // F13-SR2: 新模板 h2.headword（含 dhw 但無 hw）
    pos:        Selector::parse(".pos.dpos").unwrap(),
    pos_header: Selector::parse(".pos-header.dpos-h").unwrap(),
    pr_section: Selector::parse(".pr.entry-body__el").unwrap(),
    pos_body:   Selector::parse(".pos-body").unwrap(),
    uk_audio:   Selector::parse(".uk.dpron-i source[type='audio/mpeg']").unwrap(),
    us_audio:   Selector::parse(".us.dpron-i source[type='audio/mpeg']").unwrap(),
    def_block:  Selector::parse(".def-block.ddef_block").unwrap(),
    definition: Selector::parse(".def.ddef_d.db").unwrap(),
    example:    Selector::parse(".eg").unwrap(),
    cefr:       Selector::parse(".dxref").unwrap(),
});

// ── Public API ────────────────────────────────────────────────────────────

pub fn scrape_cambridge_html(html: &str) -> Result<EnglishLookup> {
    let document = Html::parse_document(html);

    // F13-SR2: 路由分層——新 tw-/superentry 模板零 `.entry-body`（有 def-block×N），
    // 舊 hello 模板有 `.entry-body`。以 entry_body 二分：有→舊迴圈，無→新模板 fallback。
    let has_entry_body = document.select(&SEL.entry_body).next().is_some();

    // word 取用：先舊 `.hw.dhw`（精確），新模板無此 class（只有 dhw）→ 兜底 `.headword`。
    // 連 headword 都取不到（如空檔/非條目頁）→ WordNotFound（維持原 entry-body 檢查語意）。
    let word = document
        .select(&SEL.headword)
        .next()
        .or_else(|| document.select(&SEL.headword_new).next())
        .map(|el| flatten_text(&el))
        .ok_or(Error::WordNotFound)?;

    let (uk_ipa, us_ipa) = extract_ipa(&document);

    let uk_audio = audio_src(&document, &SEL.uk_audio);
    let us_audio = audio_src(&document, &SEL.us_audio);

    let mut senses = Vec::new();

    if has_entry_body {
        // ── 舊模板：entry-body → pr_section → pos_body → def_block ──
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
                    .map(|e| flatten_text(&e))
                    .unwrap_or_default();

                if definition.is_empty() {
                    continue;
                }

                let examples: Vec<String> = block
                    .select(&SEL.example)
                    .map(|e| flatten_text(&e))
                    .filter(|s| !s.is_empty())
                    .collect();

                let cefr_level = block
                    .select(&SEL.cefr)
                    .next()
                    .map(|e| flatten_text(&e))
                    .filter(|s| !s.is_empty());

                senses.push(Sense {
                    part_of_speech: current_pos.clone(),
                    definition,
                    examples,
                    cefr_level,
                });
            }
        }
    } else {
        // ── 新模板 fallback：直接對 document select def_block（核心 sense 元素在 document 層可取得）
        for block in document.select(&SEL.def_block) {
            let definition = block
                .select(&SEL.definition)
                .next()
                .map(|e| flatten_text(&e))
                .unwrap_or_default();

            if definition.is_empty() {
                continue;
            }

            let examples: Vec<String> = block
                .select(&SEL.example)
                .map(|e| flatten_text(&e))
                .filter(|s| !s.is_empty())
                .collect();

            let cefr_level = block
                .select(&SEL.cefr)
                .next()
                .map(|e| flatten_text(&e))
                .filter(|s| !s.is_empty());

            // pos：往最近的感群（di-info）向上爬取 `.pos.dpos`；取不到 → ""（不 fail）。
            let current_pos = nearest_pos(&block).unwrap_or_default();

            senses.push(Sense {
                part_of_speech: current_pos,
                definition,
                examples,
                cefr_level,
            });
        }
    }

    if senses.is_empty() {
        return Err(Error::NoDefinitions);
    }

    Ok(EnglishLookup {
        word,
        uk_ipa,
        us_ipa,
        uk_audio,
        us_audio,
        senses,
    })
}

/// 新模板 sense 群 pos 匹配：從 def_block 沿 parent 往上爬，找到第一個含 `.pos.dpos`
/// 的元素即取其 pos（新模板 `.di-info > .pos.dpos` 為 def_block 所在感群的 sibling 鏈）。
/// 爬不到 → None（呼叫端降級為 ""）。
fn nearest_pos(block: &scraper::ElementRef) -> Option<String> {
    // 沿 parent 鏈爬（ElementRef Deref→NodeRef，NodeRef::parent() 可用）
    let mut cur = block.parent()?; // 第一步已越過 def_block 本身
    for _ in 0..8 {
        if let Some(er) = scraper::ElementRef::wrap(cur) {
            if let Some(p) = er.select(&SEL.pos).next() {
                let t = flatten_text(&p);
                if !t.is_empty() {
                    return Some(t);
                }
            }
            cur = er.parent()?;
        } else {
            cur = cur.parent()?;
        }
    }
    None
}

// ── IPA extraction ──────────────────────────────────────────────

fn extract_ipa_text(el: &scraper::ElementRef) -> Option<String> {
    el.children()
        .filter_map(|c| {
            let el = c.value().as_element()?;
            if el.attr("class").unwrap_or("").contains("ipa") {
                scraper::ElementRef::wrap(c).map(|er| flatten_text(&er))
            } else {
                None
            }
        })
        .next()
}

fn extract_ipa_from_region(el: &scraper::ElementRef) -> Option<String> {
    for child in el.children() {
        let c_el = match child.value().as_element() {
            Some(e) => e,
            None => continue,
        };
        if c_el.attr("class").unwrap_or("").contains("pron dpron")
            || c_el.attr("class").unwrap_or("").contains("dpron pron")
        {
            if let Some(er) = scraper::ElementRef::wrap(child) {
                return extract_ipa_text(&er);
            }
        }
    }
    None
}

fn extract_ipa(document: &Html) -> (Option<String>, Option<String>) {
    let header = match document.select(&SEL.pos_header).next() {
        Some(h) => h,
        None => return (None, None),
    };

    let mut uk = None;
    let mut us = None;

    for child in header.children() {
        let el = match child.value().as_element() {
            Some(e) => e,
            None => continue,
        };
        let cls = el.attr("class").unwrap_or("");

        if (cls.contains("uk dpron-i") || cls.contains("dpron-i uk")) && uk.is_none() {
            if let Some(er) = scraper::ElementRef::wrap(child) {
                uk = extract_ipa_from_region(&er);
            }
        } else if (cls.contains("us dpron-i") || cls.contains("dpron-i us")) && us.is_none() {
            if let Some(er) = scraper::ElementRef::wrap(child) {
                us = extract_ipa_from_region(&er);
            }
        } else if cls.contains("pron dpron") || cls.contains("dpron pron") {
            // Old format: .pron.dpron is a direct sibling (no .uk/.us wrapper)
            if let Some(er) = scraper::ElementRef::wrap(child) {
                let t = extract_ipa_text(&er);
                if uk.is_none() { uk = t; } else if us.is_none() { us = t; }
            }
        }
    }

    (uk, us)
}

// ─── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_html() -> String {
        r#"<!DOCTYPE html>
<html><head><title>hello | English meaning - Cambridge Dictionary</title></head>
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
        <audio><source type="audio/mpeg" src="/media/english/uk_pron/u/ukh/ukhef_029.mp3"/></audio>
      </span>
      <span class="pron dpron">/<span class="ipa dipa">həˈləʊ</span>/</span>
      <span class="us dpron-i">
        <audio><source type="audio/mpeg" src="/media/english/us_pron/h/hel/hello.mp3"/></audio>
      </span>
      <span class="pron dpron">/<span class="ipa dipa">həˈloʊ</span>/</span>
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
              <div class="examp dexamp"><span class="eg deg">Hello, Paul.</span></div>
              <div class="examp dexamp"><span class="eg deg">I know her.</span></div>
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
        let r = scrape_cambridge_html(&sample_html()).unwrap();
        assert_eq!(r.word, "hello");
        assert_eq!(r.uk_ipa.as_deref(), Some("həˈləʊ"));
        assert_eq!(r.us_ipa.as_deref(), Some("həˈloʊ"));
        assert!(r.uk_audio.unwrap().contains("uk_pron"));
        assert!(r.us_audio.unwrap().contains("us_pron"));
    }

    #[test]
    fn parses_senses() {
        let r = scrape_cambridge_html(&sample_html()).unwrap();
        assert_eq!(r.senses.len(), 1);
        assert_eq!(r.senses[0].definition, "used when meeting or greeting someone:");
        assert_eq!(r.senses[0].examples.len(), 2);
        assert_eq!(r.senses[0].cefr_level.as_deref(), Some("A1"));
        assert_eq!(r.senses[0].part_of_speech, "exclamation, noun");
    }

    #[test]
    fn errors_on_missing_entry() {
        assert!(matches!(
            scrape_cambridge_html("<html></html>"),
            Err(Error::WordNotFound)
        ));
    }

    // ── F13-SR2: 新 tw-/superentry 模板（零 .entry-body）──
    const NEW_SENSE: &str = include_str!("../testdata/get-rid-of-sense.html");
    const NEW_FULL: &str = include_str!("../testdata/get-rid-of-full.html");

    #[test]
    fn parses_new_template_sense() {
        // 單 sense 群 fixture：無 .entry-body，但有 .headword/.pos.dpos/.def-block
        let r = scrape_cambridge_html(NEW_SENSE).unwrap();
        assert_eq!(r.word, "get rid of something"); // .headword 內 <b> 展開＋span，flatten 後
        assert!(r.senses.len() >= 1, "senses={}", r.senses.len());
        assert!(r.senses[0].definition.contains("remove"), "def={}", r.senses[0].definition);
        // pos 經 nearest_pos 對應語義（phrase）
        assert_eq!(r.senses[0].part_of_speech, "phrase");
    }

    #[test]
    fn parses_new_template_full_page() {
        // 完整 get-rid-of.html：多 sense，核心 def_block fallback 全取
        let r = scrape_cambridge_html(NEW_FULL).unwrap();
        assert_eq!(r.word, "get rid of something");
        // 5 個 def-block，至少 4 個有定義
        assert!(r.senses.len() >= 4, "senses={}", r.senses.len());
        let all_have_def = r.senses.iter().all(|s| !s.definition.is_empty());
        assert!(all_have_def, "有 sense 缺 definition");
        // pos 絕非空（phrase/idiom）
        let poss: Vec<&str> = r.senses.iter().map(|s| s.part_of_speech.as_str()).collect();
        assert!(poss.iter().all(|p| *p == "phrase" || *p == "idiom"), "poss={poss:?}");
    }

    #[test]
    fn new_template_no_def_sense_skipped() {
        // fallback：存在 def_block 但該 sense 定義空 → 該 sense 跳過；全空 → NoDefinitions
        let empty = r#"<html><head></head><body><div class="headword"><b>x</b></div></body></html>"#;
        assert!(matches!(
            scrape_cambridge_html(empty),
            Err(Error::NoDefinitions)
        ));
    }
}
