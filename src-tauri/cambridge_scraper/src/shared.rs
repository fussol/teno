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
