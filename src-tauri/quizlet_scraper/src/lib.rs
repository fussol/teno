//! # quizlet_scraper
//!
//! A minimal, embeddable Quizlet flashcard scraper written in modern Rust.
//!
//! It extracts **term / definition** text pairs from any public Quizlet set —
//! no images, no audio, no diagrams — and exposes a tiny, dependency-light
//! surface area that is trivial to drop into a larger application.
//!
//! ## Entry point
//!
//! | Function                          | When to use                                            |
//! |-----------------------------------|--------------------------------------------------------|
//! | [`scrape_quizlet_html`]           | You already have the HTML (from a WebView, file, …).  |
//!
//! URL helpers: [`extract_deck_id`], [`build_flashcards_url`].
//!
//! ## Example
//!
//! ```no_run
//! # fn main() -> Result<(), Box<dyn std::error::Error>> {
//! let html = std::fs::read_to_string("saved_page.html")?;
//! let cards = quizlet_scraper::scrape_quizlet_html(&html)?;
//!
//! for card in cards {
//!     println!("{}  ->  {}", card.term, card.definition);
//! }
//! # Ok(())
//! # }
//! ```

pub mod error;
pub mod quizlet_scraper_html;
pub mod quizlet_scraper_url;

pub use error::Error;
pub use quizlet_scraper_html::{extract_title, scrape_quizlet_html, Flashcard};
pub use quizlet_scraper_url::{build_flashcards_url, extract_deck_id};

pub type Card = Flashcard;

