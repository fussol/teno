/// Percent-encode bytes of `ch` as UTF-8 `%XX` (uppercase hex).
fn push_pct(out: &mut String, ch: char) {
    for b in ch.encode_utf8(&mut [0u8; 4]).as_bytes() {
        out.push('%');
        out.push_str(&format!("{b:02X}"));
    }
}

/// Normalize + percent-encode user input into a canonical Cambridge URL
/// path segment (F13).
///
/// Cambridge phrase entries use hyphen slugs (`get rid of` -> `get-rid-of`);
/// percent-encoded spaces land on a `?q=` search-fallback page instead of the
/// entry, and reserved characters (`#`, `?`, `%`) previously broke the URL
/// path silently. Whitespace runs collapse to a single hyphen, ASCII word-ish
/// characters pass through, everything else is UTF-8 percent-encoded.
fn encode_slug(word: &str) -> String {
    // Whitespace-run fold to single hyphen + edge hyphen trim, applied to the
    // raw word before per-char encoding (Cambridge phrase slugs are hyphenated).
    let folded = word.split_ascii_whitespace().collect::<Vec<_>>().join("-");
    let folded = folded.trim_matches('-');
    let mut out = String::with_capacity(folded.len());
    for ch in folded.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '.' | '_' | '~') {
            out.push(ch);
        } else {
            push_pct(&mut out, ch);
        }
    }
    out
}

/// Build a canonical Cambridge Dictionary English-only URL.
pub fn build_english_url(word: &str) -> String {
    format!(
        "https://dictionary.cambridge.org/dictionary/english/{}",
        encode_slug(word)
    )
}

/// Build a Cambridge Dictionary English → Chinese (Traditional) URL.
pub fn build_chinese_url(word: &str) -> String {
    format!(
        "https://dictionary.cambridge.org/dictionary/english-chinese-traditional/{}",
        encode_slug(word)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn english_url() {
        assert_eq!(
            build_english_url("hello"),
            "https://dictionary.cambridge.org/dictionary/english/hello"
        );
    }

    #[test]
    fn chinese_url() {
        assert_eq!(
            build_chinese_url("hello"),
            "https://dictionary.cambridge.org/dictionary/english-chinese-traditional/hello"
        );
    }

    #[test]
    fn phrase_uses_hyphen_slug() {
        // Cambridge canonical phrase slug form (verified live: hyphen slug
        // lands on the entry page, %20 lands on ?q= fallback).
        assert_eq!(
            build_english_url("get rid of"),
            "https://dictionary.cambridge.org/dictionary/english/get-rid-of"
        );
    }

    #[test]
    fn whitespace_collapses_and_trims() {
        assert_eq!(encode_slug("  take   a \t shower \n"), "take-a-shower");
        assert_eq!(encode_slug(" -hyphen- "), "hyphen");
    }

    #[test]
    fn reserved_chars_percent_encoded() {
        assert_eq!(encode_slug("c#"), "c%23");
        assert_eq!(encode_slug("100%"), "100%25");
        assert_eq!(encode_slug("a?b"), "a%3Fb");
        assert_eq!(encode_slug("x/y"), "x%2Fy");
        assert_eq!(encode_slug("a&b=c"), "a%26b%3Dc");
    }

    #[test]
    fn cjk_percent_encoded_utf8() {
        assert_eq!(encode_slug("中文"), "%E4%B8%AD%E6%96%87");
    }
}
