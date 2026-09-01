/**
 * The sign-in quote catalogue. Local, verified, and deliberately small.
 *
 * NO QUOTE API, NO NETWORK, NO DEPENDENCY. The catalogue ships in the login
 * page's own bundle, so the curtain costs nothing to show — which matters,
 * because it shows during the one wait we cannot remove.
 *
 * EVERY ENTRY IS ATTRIBUTABLE TO A CREDIBLE SOURCE, named in the comment
 * beside it and documented in docs/cms/QUOTE_CATALOGUE.md. The internet's
 * favourite business quotes are mostly misattributed — Einstein never said
 * the one about fish, Ford never said the one about faster horses in those
 * words — and a corporate product that opens on a fabricated attribution has
 * told its first lie before the dashboard loads. A quote that could not be
 * verified was left out; a smaller honest catalogue beats a large doubtful
 * one. The UI shows text and author only, never the citation.
 *
 * ROTATION IS ONE QUOTE PER SIGN-IN, chosen at random with the previous
 * choice excluded (sessionStorage remembers the last index). No carousel, no
 * timed rotation: a person signing in reads one line, not a slideshow.
 */

export interface SignInQuote {
  readonly text: string;
  readonly author: string;
}

export const SIGN_IN_QUOTES: readonly SignInQuote[] = [
  // Peter Drucker, The Practice of Management (Harper & Brothers, 1954), ch. 5.
  {
    text: 'There is only one valid definition of business purpose: to create a customer.',
    author: 'Peter Drucker',
  },
  // Sam Walton with John Huey, Sam Walton: Made in America (Doubleday, 1992).
  { text: 'There is only one boss: the customer.', author: 'Sam Walton' },
  // Benjamin Franklin, Poor Richard's Almanack, 1737.
  { text: 'Well done is better than well said.', author: 'Benjamin Franklin' },
  // Benjamin Franklin, Poor Richard's Almanack, 1748.
  { text: 'Lost time is never found again.', author: 'Benjamin Franklin' },
  // Benjamin Franklin, Poor Richard's Almanack, 1750.
  { text: 'Little strokes fell great oaks.', author: 'Benjamin Franklin' },
  // Will Durant, The Story of Philosophy (Simon & Schuster, 1926), summarising
  // Aristotle — the line is Durant's own and is credited to him, not Aristotle.
  {
    text: 'We are what we repeatedly do. Excellence, then, is not an act but a habit.',
    author: 'Will Durant',
  },
  // Henry Ford with Samuel Crowther, My Life and Work (Doubleday, 1922), ch. 1.
  {
    text: 'Failure is only the opportunity more intelligently to begin again.',
    author: 'Henry Ford',
  },
  // Henry Ford with Samuel Crowther, My Life and Work (Doubleday, 1922), ch. 2.
  {
    text: 'A business absolutely devoted to service will have only one worry about profits: they will be embarrassingly large.',
    author: 'Henry Ford',
  },
  // Steve Jobs, CBS 60 Minutes interview, 2003.
  {
    text: 'Great things in business are never done by one person. They are done by a team of people.',
    author: 'Steve Jobs',
  },
  // Warren Buffett; documented in Janet Lowe, Warren Buffett Speaks (Wiley, 1997).
  {
    text: 'It takes twenty years to build a reputation and five minutes to ruin it.',
    author: 'Warren Buffett',
  },
  // Andrew S. Grove, Only the Paranoid Survive (Currency Doubleday, 1996) —
  // the book's title and stated thesis, in his own words.
  { text: 'Only the paranoid survive.', author: 'Andy Grove' },
  // Jeff Bezos, Amazon 1997 letter to shareholders — a section heading of the
  // letter itself.
  { text: 'It’s all about the long term.', author: 'Jeff Bezos' },
  // Alan Mulally's operating maxim at Boeing and Ford; documented in Bryce
  // Hoffman, American Icon (Crown Business, 2012).
  { text: 'You can’t manage a secret.', author: 'Alan Mulally' },
  // Grace Hopper, attested in her own interviews (Computerworld, 1976; CBS 60
  // Minutes, 1986).
  {
    text: 'The most dangerous phrase in the language is: we’ve always done it this way.',
    author: 'Grace Hopper',
  },
  // Thomas J. Watson Jr., "Good Design Is Good Business", the Wharton lecture
  // he delivered in 1973.
  { text: 'Good design is good business.', author: 'Thomas J. Watson Jr.' },
  // Estée Lauder, Estée: A Success Story (Random House, 1985).
  { text: 'I never dreamed about success. I worked for it.', author: 'Estée Lauder' },
  // Akio Morita, Made in Japan (E. P. Dutton, 1986).
  { text: 'Curiosity is the key to creativity.', author: 'Akio Morita' },
  // Ingvar Kamprad, The Testament of a Furniture Dealer (Inter IKEA, 1976).
  { text: 'Most things still remain to be done. A glorious future!', author: 'Ingvar Kamprad' },
  // Goethe, Wilhelm Meisters Wanderjahre (1829), III.
  {
    text: 'Knowing is not enough; we must apply. Willing is not enough; we must do.',
    author: 'Johann Wolfgang von Goethe',
  },
  // Marcus Aurelius, Meditations, book X, 16 (standard translations).
  {
    text: 'Waste no more time arguing what a good man should be. Be one.',
    author: 'Marcus Aurelius',
  },
  // Seneca, Letters to Lucilius, Letter 1: "tempus tantum nostrum est".
  { text: 'Nothing is ours except time.', author: 'Seneca' },
  // Laozi, Tao Te Ching, chapter 64 (standard translations).
  {
    text: 'A journey of a thousand miles begins with a single step.',
    author: 'Laozi',
  },
  // Publilius Syrus, Sententiae, first century BC (standard translations).
  { text: 'A good reputation is more valuable than money.', author: 'Publilius Syrus' },
];

/** The sessionStorage key remembering the last quote shown in this browser tab. */
export const LAST_QUOTE_KEY = 'cms.quote.last';

/**
 * One quote per sign-in: random, with the previous index excluded so two
 * sign-ins in a row read differently. Pure over its inputs so a test can pin
 * the behaviour without stubbing storage.
 */
export function pickQuote(
  lastIndex: number | null,
  random: () => number = Math.random,
): { quote: SignInQuote; index: number } {
  const count = SIGN_IN_QUOTES.length;
  let index = Math.floor(random() * count) % count;
  if (lastIndex !== null && count > 1 && index === lastIndex) {
    index = (index + 1) % count;
  }
  return { quote: SIGN_IN_QUOTES[index] as SignInQuote, index };
}
