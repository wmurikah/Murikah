# Murikah brand assets

Confirmed by visually inspecting each uploaded PNG under `docs/images/`. The
files are named by number only; the mapping below records what each one actually
contains, so use each by its content, not its number.

## Confirmed mapping

| Source file                 | What it is                                                                                           | Used as                                                                                                                                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/images/murikah_1.png` | Website header / hero **mock reference** (dark hero, building photograph, serif headline, brass CTA) | Design reference only. Never placed on the live site. Recreated in code (see `src/pages/index.astro` and `src/components/Header.astro`).                                                                                              |
| `docs/images/murikah_2.png` | App icon / favicon (navy rounded tile, ivory M, brass accent)                                        | `public/brand/murikah-app-icon.png`. The live favicon is the crisp vector `public/favicon.svg`; the mobile home-screen icon is `public/apple-touch-icon.png` (a full-bleed square of the same mark, so iOS can mask its own corners). |
| `docs/images/murikah_3.png` | Horizontal **reversed / dark** lockup (M + divider + MURIKAH + brass tagline, on navy)               | `public/brand/murikah-logo-horizontal-dark.png`. For dark surfaces: dark header, dark hero, dark footer, dark CTA bands. The site chrome recreates this lockup in code for crispness (see below).                                     |
| `docs/images/murikah_4.png` | **Stacked** light lockup (centred M over MURIKAH + tagline, on ivory)                                | `public/brand/murikah-logo-stacked-light.png`. Centred brand moments: contact, proposal / report covers.                                                                                                                              |
| `docs/images/murikah_5.png` | Horizontal **light** lockup (M + divider + MURIKAH + tagline, on ivory)                              | `public/brand/murikah-logo-horizontal-light.png`. Light-background sections and report-style layouts.                                                                                                                                 |
| `docs/images/murikah_6.png` | White **dark-header lockup** (white M + brass accent + divider + MURIKAH, on black)                  | `public/images/murikah-logo-dark.png`, used as the header logo on the dark bar (alt "Murikah"). The earlier light standalone monogram remains at `public/brand/murikah-monogram-light.png`.                                           |

`murikah_1.png` is the website theme reference. It is not a logo asset.

## Code vs raster

The live header and footer render the lockup **in code** (`src/components/Logo.astro`):
a vector M monogram, a hairline divider and the tracked "MURIKAH" wordmark, in
the same styling as the reversed-dark and light lockups above. Vector keeps the
mark crisp at every size and lets it recolour by surface (ivory on dark, navy on
light) without shipping several raster files in the page chrome.

The raster files in `public/brand/` are the portable brand library for places a
flat image is the right tool: decks, PDFs, report covers, social cards, email
signatures and third-party profiles. Filenames describe the content so they do
not have to be opened to be understood.

## Palette used by the marks

Navy `#0B1733`, obsidian `#070B12`, ivory `#F8F4EA`, aged brass `#A9822E`. The
brass is the single accent (the monogram's diagonal and the tagline dots).
