use crate::error::{Error, Result};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct TatoebaResponse {
    pub data: Vec<TatoebaSentence>,
    pub paging: TatoebaPaging,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct TatoebaSentence {
    pub id: i64,
    pub text: String,
    pub lang: String,
    pub script: Option<String>,
    pub translations: Vec<TatoebaTranslation>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct TatoebaTranslation {
    pub id: i64,
    pub text: String,
    pub lang: String,
    pub script: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct TatoebaPaging {
    pub total: i64,
    pub has_next: bool,
}

/// Build a Tatoeba sentence search URL.
pub fn build_tatoeba_url(word: &str, from: &str, to: &str, limit: u32) -> String {
    url::Url::parse_with_params(
        "https://api.tatoeba.org/v1/sentences",
        &[
            ("lang", from),
            ("q", word),
            ("trans:lang", to),
            ("sort", "relevance"),
            ("limit", &limit.to_string()),
        ],
    )
    .map(|u| u.to_string())
    .unwrap_or_else(|_| {
        format!(
            "https://api.tatoeba.org/v1/sentences?lang={from}&q={word}&trans:lang={to}&sort=relevance&limit={limit}"
        )
    })
}

pub fn parse_tatoeba_response(json: &str) -> Result<TatoebaResponse> {
    let resp: TatoebaResponse = serde_json::from_str(json).map_err(Error::Json)?;
    Ok(resp)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_json() -> String {
        r#"{
            "data": [
                {
                    "id": 1858850,
                    "text": "Hello.",
                    "lang": "eng",
                    "script": null,
                    "license": "CC BY 2.0 FR",
                    "owner": "LanguageExpert",
                    "is_unapproved": false,
                    "translations": [
                        {
                            "id": 4857568,
                            "text": "你好。",
                            "lang": "cmn",
                            "script": "Hans",
                            "license": "CC BY 2.0 FR",
                            "owner": "musclegirlxyp",
                            "is_unapproved": false,
                            "is_direct": true
                        },
                        {
                            "id": 13174772,
                            "text": "你們好！",
                            "lang": "cmn",
                            "script": "Hant",
                            "license": "CC BY 2.0 FR",
                            "owner": "atitarev",
                            "is_unapproved": false,
                            "is_direct": true
                        }
                    ]
                }
            ],
            "paging": {
                "total": 77,
                "has_next": true
            }
        }"#
        .to_string()
    }

    #[test]
    fn parses_response() {
        let resp = parse_tatoeba_response(&sample_json()).unwrap();
        assert_eq!(resp.data.len(), 1);
        assert_eq!(resp.paging.total, 77);
    }

    #[test]
    fn parses_sentence() {
        let resp = parse_tatoeba_response(&sample_json()).unwrap();
        let s = &resp.data[0];
        assert_eq!(s.text, "Hello.");
        assert_eq!(s.lang, "eng");
        assert_eq!(s.translations.len(), 2);
    }

    #[test]
    fn parses_translation_scripts() {
        let resp = parse_tatoeba_response(&sample_json()).unwrap();
        let t = &resp.data[0].translations;
        assert_eq!(t[0].script.as_deref(), Some("Hans"));
        assert_eq!(t[1].script.as_deref(), Some("Hant"));
    }

    #[test]
    fn builds_url() {
        let url = build_tatoeba_url("hello", "eng", "cmn", 10);
        assert!(url.starts_with("https://api.tatoeba.org/v1/sentences?"));
        assert!(url.contains("lang=eng"));
        assert!(url.contains("q=hello"));
        assert!(url.contains("trans%3Alang=cmn"));
        assert!(url.contains("limit=10"));
    }
}
