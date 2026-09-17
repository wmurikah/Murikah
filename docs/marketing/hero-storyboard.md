# Murikah hero film

Creative reference: latent-spaces/brag, `skills/brag` storyboard and readability guidance (reviewed 17 September 2026).

The film borrows that guidance; it is not a Hyperframes render. Pillow and FFmpeg render a checked-in MP4 offline. No video tooling is added to the website dependencies, build or Cloudflare deployment.

- Product: internal audit, governance services and four existing applications.
- Angle: show how evidence becomes an owned, reviewable action.
- Hook: “From evidence to action.”
- Visual: slate #1e2a30, ivory #fffdf5, brass #d6b365; restrained typography and rules.
- Source: the existing Assurance OS workflow and audit finding terminology. The scene is explicitly an illustration with fictional data, not a product screenshot or client result.
- Tone: polished; quiet authority.
- Format: 1280×720, 24fps, exactly 20 seconds.
- Audio: intentionally silent for a website hero; no narration, music or sound effects.
- Flow: evidence recorded → reviewer checks scope → owner assigned → closure validated.
- Caption: Murikah connects evidence, review and action, with workspaces for audit, customer operations, learning and engineering.

| Seconds | Scene                                 | Readable hold |
| ------- | ------------------------------------- | ------------- |
| 0–4     | Finding and missing approval evidence | 4s            |
| 4–8     | Review evidence, scope and risk       | 4s            |
| 8–12    | Assign an owner and action            | 4s            |
| 12–16   | Validate closure evidence             | 4s            |
| 16–20   | CMS, GRC, Tutor and ENGR              | 4s            |

Native playback controls; no autoplay, no loop, preload=none, poster and adjacent text description. Static headline and links are outside the film. Motion is always user initiated, including for reduced-motion users. Frame zero is the chosen, settled poster.

Rebuild with `python scripts/marketing/render-hero.py` (Pillow, DejaVu fonts and FFmpeg installed).
