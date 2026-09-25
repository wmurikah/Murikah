# Murikah Workbench

Murikah Workbench is Tutor's opt-in editing surface for completed responses and source-backed visual outputs.

## Product contract

Workbench MUST NOT sit on the ordinary Tutor response path.

- Tutor streams and completes the answer normally.
- Only after a response is complete may the UI offer **Open in Workbench**.
- The Workbench panel bundle is lazy-loaded only after the user opens it.
- Manual editing is client-side and MUST NOT call an LLM, provider, or Tutor API.
- Closing Workbench returns to the same conversation without creating a new turn.
- Browser-local autosave is a convenience checkpoint, not a server-side record or a claim of cross-device persistence.
- Users can download a portable copy at any time.

## Supported editable sources

### Documents

Assistant Markdown responses open as editable Markdown with a rendered preview.

### Tables

Rendered Markdown tables expose **Copy** and **Edit** controls.

Copy writes:

- `text/html` for Word/rich editors; and
- tab-separated `text/plain` for Excel, Google Sheets and other spreadsheet tools.

When the richer Clipboard API is unavailable, Tutor falls back to TSV text.

Workbench preserves table rows and columns as a cell grid. Editing a cell does not flatten the table into prose.

### Code

Source-backed code can be edited as text, versioned locally, copied and downloaded.

### Diagrams

Murikah Diagram Design SVG and Mermaid diagrams open from their underlying SVG/Mermaid source. SVG preview is rendered in a sandboxed iframe with a deny-by-default Content Security Policy. Mermaid continues through Tutor's existing Mermaid renderer.

### Visualizations

Tutor's existing source-backed visualization results can open in Workbench:

- SVG;
- Mermaid;
- Chart.js;
- HTML;
- plugin/iframe payloads; and
- GeoGebra payloads.

Native/code renderers edit `code.content`. Payload-driven renderers edit `payload.data` as JSON. Preview reuses the existing `VisualizationViewer` safety and renderer contracts.

Math Animator output can expose its generated source for editing, but Workbench does not pretend it can re-render a Manim video in the browser. A new server render remains a separate workflow.

## Local editing and versions

Workbench autosaves a bounded draft in browser `localStorage` only after the user actually edits content or saves a version. Merely opening Workbench does not duplicate the Tutor response into persistent browser storage.

- maximum active draft: 500,000 characters;
- maximum explicit local versions: 8;
- local storage keys use opaque IDs/hashes and MUST NOT embed document/table contents;
- **Reset** restores the exact source supplied by Tutor;
- **Clear local** removes browser-local edits and versions;
- **Version** snapshots the current local draft;
- **Download** creates a portable file without a server request.

## UI behavior

Desktop: Workbench is a right-side sibling panel so chat remains visible.

Mobile: Workbench becomes a full-screen editor.

`Escape` closes the panel. The ordinary chat bundle does not import the editor panel eagerly.

## Security and privacy

- Workbench manual edits do not call `fetch`, `apiFetch` or any Tutor API.
- SVG preview uses `sandbox=""` and a deny-by-default CSP.
- HTML preview uses a sandboxed opaque-origin iframe and blocks network connections through CSP.
- Existing VisualizationViewer sanitization and iframe isolation continue to apply.
- Workbench never writes edited content back into the original Tutor message silently.

## Release checks

The Tutor Cloudflare preflight guards lazy loading, no-network editing, table clipboard formats, sandboxing and renderer wiring.

The production image runs `tests/integration/workbench.spec.tsx`, which checks:

- HTML/TSV-capable table copy and TSV fallback;
- structured table editing;
- document editing without a network call;
- sandboxed SVG editing/preview;
- browser-local autosave and version restore.

Diagram Design integration separately verifies that a completed SVG opens as SVG source in Workbench.

## Subsequent Workbench development requirement

Future Workbench changes must preserve the latency boundary: no Workbench code may add an LLM call, provider decision, persistence round-trip or heavyweight editor dependency to Tutor's initial chat load or response streaming path.

Server-side/cross-device Workbench persistence, collaborative editing, richer spreadsheet semantics and AI-assisted targeted edits are separate future capabilities and must be introduced deliberately with their own ownership, privacy, conflict and latency contracts.
