use scraper::ElementRef;

/// Join all descendant text nodes, normalise whitespace, and trim.
pub(crate) fn flatten_text(el: &ElementRef) -> String {
    el.text()
        .collect::<Vec<_>>()
        .concat()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// ANTFIX：sense 歸屬判定 —— headword 與查詢字大小寫無關相等才算同一條目。
/// 用途：lookup_cambridge 同頁多條目過濾（ant/-ant）；呼叫端對不上半個時回退全留，
/// 片語變體（get rid of something vs get rid of）不誤殺。
pub fn headword_matches(hw: &str, query: &str) -> bool {
    hw.trim().eq_ignore_ascii_case(query.trim())
}

/// Extract the `src` attribute of the first matching audio source and
/// prepend the Cambridge domain.
pub(crate) fn audio_src(
    document: &scraper::Html,
    sel: &scraper::Selector,
) -> Option<String> {
    document
        .select(sel)
        .next()
        .and_then(|el| el.value().attr("src"))
        .map(|src| format!("https://dictionary.cambridge.org{src}"))
}
