# Product workflow film

60 seconds, silent, 24 fps, 1280 × 900. The 64:45 canvas is 25% taller than the previous 16:9 film at the same width. Native playback controls remain available; playback is user initiated. No additional browser dependency or deployment step is introduced.

The film is an animated UI demonstration with sample records, **not a live screen recording**. Product interfaces are simplified and enlarged for legibility in the hero. Cursor movement, click pulses, typed input, a sliding drawer, streamed answer text and changing workflow states show actions and outcomes. A persistent sample-record label distinguishes the demonstration from customer evidence.

| Time    | Interaction and result                                                                        | Repository basis                                                                                                                                           |
| ------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0–15 s  | Tutor: type a precision/recall question, send it, read the answer as it appears.              | Tutor chat UI and message list; `tutor/README.md` describes the separately hosted app. The response is a scripted teaching example, not a model benchmark. |
| 15–30 s | CMS: open the lead drawer, enter a title, choose source and owner, create the lead.           | `src/components/cms/CmsLeadCreateDrawer.astro`; account is optional at creation. No conversion is implied.                                                 |
| 30–45 s | ENGR: open an accepted work order, choose a technician, assign them, see the timeline update. | `src/components/engr/WorkOrderDetail.astro`; stops before technician acceptance and site safety steps.                                                     |
| 45–60 s | GRC: link an observation, type a remediation action, set its date and owner, create the plan. | `src/pages/grc/action-plans/new.astro`; does not imply review or closure.                                                                                  |

Colours follow the product family: Tutor's light sidebar and the navy/gold ENGR/GRC tokens in `src/styles/engr.css` and `src/styles/grc.css`. Fictional names and records are baked into the movie; it never calls production APIs.

## Rebuild

From the repository root, with Python, Pillow, DejaVu Sans and FFmpeg installed:

```sh
python scripts/marketing/render-hero.py
ffprobe -v error -show_entries stream=width,height,r_frame_rate -show_entries format=duration,size public/media/murikah-hero.mp4
```

The renderer writes the committed MP4 and JPEG poster. It is an offline authoring tool, not part of Cloudflare deployment. The poster shows the settled Tutor answer. Important interface content sits above the native control overlay. The accessible caption describes all four workflows; there is no visible paragraph beneath the film.
