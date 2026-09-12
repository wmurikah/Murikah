# Murikah Tutor Diagram Design

Murikah Tutor includes a guest-facing **Diagram Design** experience for turning ideas, processes, architectures, systems and data stories into editorial SVG diagrams.

The product direction is inspired by Cathryn Lavery's open-source `cathrynlavery/diagram-design` project (MIT License), particularly its emphasis on choosing a diagram grammar that matches the information, keeping visual density restrained, using self-contained HTML/SVG output, avoiding decorative shadows, and reserving accent colour for the few elements that matter most.

Murikah does not vendor the upstream plugin, templates, screenshots or scripts. The Tutor implementation is an original runtime integration built on the existing Murikah guest LLM endpoint. It asks the configured Tutor model to choose an appropriate diagram grammar and return a self-contained SVG using the Murikah palette.

## Guest safety boundary

Generated SVG is displayed inside a sandboxed `srcDoc` iframe. The preview has a restrictive Content Security Policy: no scripts, network connections, external fonts, remote images, objects or child frames. Script and `foreignObject` blocks and event-handler attributes are also stripped before preview. This keeps model-generated diagram markup isolated from the Tutor application.

## Guest behaviour

- Diagram Design is one of the curated guest sidebar/mobile Explore experiences.
- Selecting it starts a fresh guest context, like other guest spaces.
- It uses the existing `visualize` learning mode by default.
- A successful diagram generation consumes one normal guest interaction; failed upstream calls do not increment the guest allowance.
- Guest diagram responses may use a larger completion budget than ordinary guest chat because SVG markup is verbose.

Upstream inspiration: https://github.com/cathrynlavery/diagram-design
