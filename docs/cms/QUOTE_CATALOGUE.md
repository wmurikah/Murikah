# The sign-in quote catalogue

The Quote Curtain (`src/components/cms/CmsQuoteCurtain.astro`) shows one quote
per successful sign-in, drawn from the local catalogue in
`src/lib/cms/auth/quotes.ts`. This document records where every quote comes
from, because the catalogue's one hard rule is that **an unverifiable quote is
not used**. The internet's favourite business quotes are largely misattributed,
and a corporate product that opens on a fabricated attribution has told its
first lie before the dashboard loads.

## Rules the catalogue follows

- **Local and static.** No quote API, no network call, no dependency. The
  catalogue ships in the login page's own bundle.
- **18 words or fewer**, professional in register, aligned with the themes the
  brief names: customers, leadership, execution, quality, service, simplicity,
  teamwork, innovation, discipline. Enforced by
  `test/cms/performance.test.ts`.
- **Attributable to a credible primary or reputable secondary source**, named
  below. Candidates that failed verification were dropped rather than kept
  with a hedge — among the rejected: Ford's "faster horses" (no primary
  source), da Vinci's "simplicity is the ultimate sophistication" (appears
  nowhere in his writings), Deming's "In God we trust; all others must bring
  data" (unsourced), and the habit line as "Aristotle" (it is Will Durant's
  paraphrase, credited here to Durant).
- **One quote per sign-in.** Random, with the previous index excluded via
  `sessionStorage` (`cms.quote.last`), so two sign-ins in a row read
  differently. No rotation timer, no carousel.
- The UI shows text and author only. Citations live in the source comments and
  here.

## The catalogue and its sources

| Quote (abridged)                                                                            | Author                     | Source                                                                                                     |
| ------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| "There is only one valid definition of business purpose: to create a customer."             | Peter Drucker              | _The Practice of Management_, Harper & Brothers, 1954, ch. 5                                               |
| "There is only one boss: the customer."                                                     | Sam Walton                 | _Sam Walton: Made in America_ (with John Huey), Doubleday, 1992                                            |
| "Well done is better than well said."                                                       | Benjamin Franklin          | _Poor Richard's Almanack_, 1737                                                                            |
| "Lost time is never found again."                                                           | Benjamin Franklin          | _Poor Richard's Almanack_, 1748                                                                            |
| "Little strokes fell great oaks."                                                           | Benjamin Franklin          | _Poor Richard's Almanack_, 1750                                                                            |
| "We are what we repeatedly do. Excellence, then, is not an act but a habit."                | Will Durant                | _The Story of Philosophy_, Simon & Schuster, 1926 — Durant's summary of Aristotle, credited to Durant      |
| "Failure is only the opportunity more intelligently to begin again."                        | Henry Ford                 | _My Life and Work_ (with Samuel Crowther), Doubleday, 1922, ch. 1                                          |
| "A business absolutely devoted to service will have only one worry about profits…"          | Henry Ford                 | _My Life and Work_, 1922, ch. 2                                                                            |
| "Great things in business are never done by one person. They are done by a team of people." | Steve Jobs                 | CBS _60 Minutes_ interview, 2003                                                                           |
| "It takes twenty years to build a reputation and five minutes to ruin it."                  | Warren Buffett             | Documented in Janet Lowe, _Warren Buffett Speaks_, Wiley, 1997                                             |
| "Only the paranoid survive."                                                                | Andy Grove                 | _Only the Paranoid Survive_, Currency Doubleday, 1996 — the book's title and stated thesis                 |
| "It's all about the long term."                                                             | Jeff Bezos                 | Amazon 1997 letter to shareholders (a section heading of the letter)                                       |
| "You can't manage a secret."                                                                | Alan Mulally               | His operating maxim at Boeing and Ford; documented in Bryce Hoffman, _American Icon_, Crown Business, 2012 |
| "The most dangerous phrase in the language is: we've always done it this way."              | Grace Hopper               | Her own interviews (Computerworld 1976; CBS _60 Minutes_ 1986)                                             |
| "Good design is good business."                                                             | Thomas J. Watson Jr.       | "Good Design Is Good Business", Wharton lecture, 1973                                                      |
| "I never dreamed about success. I worked for it."                                           | Estée Lauder               | _Estée: A Success Story_, Random House, 1985                                                               |
| "Curiosity is the key to creativity."                                                       | Akio Morita                | _Made in Japan_, E. P. Dutton, 1986                                                                        |
| "Most things still remain to be done. A glorious future!"                                   | Ingvar Kamprad             | _The Testament of a Furniture Dealer_, Inter IKEA, 1976                                                    |
| "Knowing is not enough; we must apply. Willing is not enough; we must do."                  | Johann Wolfgang von Goethe | _Wilhelm Meisters Wanderjahre_, 1829, book III                                                             |
| "Waste no more time arguing what a good man should be. Be one."                             | Marcus Aurelius            | _Meditations_, book X, 16 (standard translations)                                                          |
| "Nothing is ours except time."                                                              | Seneca                     | _Letters to Lucilius_, Letter 1 ("tempus tantum nostrum est")                                              |
| "A journey of a thousand miles begins with a single step."                                  | Laozi                      | _Tao Te Ching_, chapter 64 (standard translations)                                                         |
| "A good reputation is more valuable than money."                                            | Publilius Syrus            | _Sententiae_, first century BC (standard translations)                                                     |

23 quotes. The brief allows 20–40; a smaller honest catalogue beats a larger
doubtful one, and Saint-Exupéry's "perfection is achieved…" — genuine, from
_Terre des Hommes_ (1939) — was cut only because its faithful English
translation runs to 20 words, over the 18-word limit.

## Changing the catalogue

Add the quote to `SIGN_IN_QUOTES` with a source comment beside it, add the row
here, and keep the count within 20–40. If the source cannot be named, the
quote does not go in.
