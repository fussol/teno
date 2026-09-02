/// Build the canonical Cambridge Dictionary URL for a word.
pub fn build_dictionary_url(word: &str) -> String {
    format!(
        "https://dictionary.cambridge.org/dictionary/english/{}",
        word
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_url_for_simple_word() {
        assert_eq!(
            build_dictionary_url("hello"),
            "https://dictionary.cambridge.org/dictionary/english/hello"
        );
    }

    #[test]
    fn builds_url_for_compound_word() {
        assert_eq!(
            build_dictionary_url("look up"),
            "https://dictionary.cambridge.org/dictionary/english/look up"
        );
    }
}
