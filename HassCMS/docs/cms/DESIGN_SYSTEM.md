# Hass CMS visual architecture

The CMS uses a quiet, predominantly light workspace anchored by Hass navy navigation and scarce Hass gold emphasis. Visual hierarchy comes from typography, spacing, and task-aware composition rather than additional colours, decorative shadows, or repeated cards.

## Core composition

- **Shell:** navigation labels are visible by default on large desktops, remain deliberately collapsible, and are grouped by work context. Laptop and mobile layouts conserve space without removing accessible names.
- **Widths:** use `focus` for narrow tasks and forms, `detail` for records, `standard` for ordinary workspaces, and `data` for dashboards and analytical tables.
- **Hierarchy:** each page has one editorial title and one dominant action. Business content precedes advanced controls.
- **Surfaces:** the warm canvas is the default. A surface indicates a genuine grouped region; whitespace should group content before another card is introduced.
- **Metrics:** figures lead through typography. Semantic colour describes state and is always accompanied by text; decorative metric bars are prohibited.
- **Navigation versus modes:** underline-style navigation changes sections; segmented controls switch mutually exclusive views of the same material.
- **Responsive lists:** desktop tables retain semantics. Important mobile work queues become readable entity rows with identity, essential context, and status rather than a table with arbitrary columns hidden.

## Accessibility contract

Minimalism must never remove persistent labels, visible focus, semantic status text, error associations, keyboard access, reduced-motion handling, or useful touch targets. Colour is never the only signal. Missing values retain the distinction between zero and unavailable; dense views may render an em dash only when its accessible name remains “Not available.”

## Implementation boundaries

Presentation consumes the existing server-rendered records and URL state. Authentication, sessions, RBAC, tenant scope, database access, workflows, SLA state, analytics definitions, and API contracts are frozen. A visual proposal that needs any of those to change is documented as blocked rather than implemented.
