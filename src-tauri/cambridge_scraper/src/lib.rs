pub mod chinese;
pub mod english;
pub mod error;
pub mod shared;
pub mod tatoeba;
pub mod url;

pub use chinese::{scrape_cambridge_chinese_html, ChineseExample, ChineseLookup, ChineseSense};
pub use english::{scrape_cambridge_html, EnglishLookup, Sense};
pub use error::Error;
pub use tatoeba::{build_tatoeba_url, parse_tatoeba_response, TatoebaResponse, TatoebaSentence, TatoebaTranslation};
pub use url::{build_chinese_url, build_english_url};
