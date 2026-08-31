/**
 * The user record's sections, and what an old bookmark means now.
 *
 * NINE PRIMARY TABS WAS THE DATA MODEL ON SCREEN. Overview, Edit, Assignments,
 * Teams, Roles, Workflow authority, Source identities, Security, Audit — one
 * per table, which is a fine way to build a page and a poor way to read one.
 * A person opening somebody's record is doing one of about five things, and
 * nine equally weighted choices makes them translate their errand into the
 * schema before they can start.
 *
 * So the PRIMARY choice is now six task-shaped sections, and the old nine are
 * subsections inside them. Nothing moved tables, merged repositories or
 * changed a permission: Access shows roles and workflow authority side by side
 * because an administrator asking "what can this person do" wants both, and
 * they remain two separate concepts resolved by separate code behind separate
 * permissions. Grouping them on a screen is not merging them.
 *
 * OLD LINKS KEEP WORKING, AND THIS IS THE FILE THAT MAKES THAT TRUE. Somebody
 * has `?tab=assignments` in a bookmark, in an email, in a runbook. That link
 * opens Organisation with Assignments selected — not a 404, and not a silent
 * landing on Overview, which is the failure that teaches people the
 * application loses their place. The mapping is data, so a test can walk every
 * legacy key and assert none of them is dropped.
 */

/** The six task-shaped sections a person chooses between. */
export const USER_SECTIONS = [
  'overview',
  'edit',
  'organisation',
  'access',
  'security',
  'history',
] as const;
export type UserSection = (typeof USER_SECTIONS)[number];

/** The subsections inside a section, in the order they are offered. */
export interface UserView {
  readonly key: string;
  readonly label: string;
}

export interface UserSectionModel {
  readonly section: UserSection;
  readonly label: string;
  /** Empty where the section has one thing in it and needs no local chooser. */
  readonly views: readonly UserView[];
}

export const USER_SECTION_MODEL: readonly UserSectionModel[] = [
  { section: 'overview', label: 'Overview', views: [] },
  { section: 'edit', label: 'Edit', views: [] },
  {
    section: 'organisation',
    label: 'Organisation',
    views: [
      { key: 'assignments', label: 'Assignments' },
      { key: 'teams', label: 'Teams' },
    ],
  },
  {
    section: 'access',
    label: 'Access',
    views: [
      { key: 'roles', label: 'Access roles' },
      { key: 'authority', label: 'Workflow authority' },
    ],
  },
  {
    section: 'security',
    label: 'Security',
    views: [
      { key: 'identities', label: 'Identity' },
      { key: 'security', label: 'Security' },
    ],
  },
  { section: 'history', label: 'History', views: [] },
];

/**
 * Every `?tab=` value the page has ever accepted, and where it lands now.
 *
 * The six section names map to themselves, so a new link and an old one are
 * read by the same code path. The legacy nine map to their parent and the view
 * that shows what they used to show. `audit` is the one rename: the section is
 * called History because that is what a person calls it, and the tab was
 * called Audit because that is what the table is called.
 */
const LEGACY: Readonly<Record<string, { section: UserSection; view: string | null }>> = {
  overview: { section: 'overview', view: null },
  edit: { section: 'edit', view: null },
  assignments: { section: 'organisation', view: 'assignments' },
  teams: { section: 'organisation', view: 'teams' },
  roles: { section: 'access', view: 'roles' },
  authority: { section: 'access', view: 'authority' },
  identities: { section: 'security', view: 'identities' },
  security: { section: 'security', view: 'security' },
  audit: { section: 'history', view: null },
  organisation: { section: 'organisation', view: null },
  access: { section: 'access', view: null },
  history: { section: 'history', view: null },
};

/** The legacy keys, so a test can assert every one of them still resolves. */
export const LEGACY_USER_TABS: readonly string[] = [
  'assignments',
  'teams',
  'roles',
  'authority',
  'identities',
  'security',
  'audit',
];

export interface ResolvedUserTab {
  section: UserSection;
  /** The chosen subsection, or the section's first where it has any. */
  view: string | null;
}

/**
 * Read `?tab=` and `?view=` into a section and a subsection.
 *
 * An unrecognised tab lands on Overview, which is the only honest answer to a
 * value that means nothing: there is no page to reveal and inventing one would
 * be worse than the record's own front page. An unrecognised VIEW inside a
 * real section falls back to that section's first, so a mangled subsection
 * never costs somebody the section they asked for.
 */
export function resolveUserTab(
  requestedTab: string | null,
  requestedView: string | null,
): ResolvedUserTab {
  const mapped = LEGACY[requestedTab ?? ''] ?? { section: 'overview' as UserSection, view: null };
  const model = USER_SECTION_MODEL.find((entry) => entry.section === mapped.section);
  if (model === undefined || model.views.length === 0) {
    return { section: mapped.section, view: null };
  }
  const asked = requestedView ?? mapped.view;
  const chosen = model.views.find((view) => view.key === asked);
  return { section: mapped.section, view: (chosen ?? model.views[0])?.key ?? null };
}

/** The canonical link to one section, and optionally one view inside it. */
export function userSectionHref(base: string, section: UserSection, view?: string | null): string {
  const query = view === undefined || view === null ? '' : `&view=${encodeURIComponent(view)}`;
  return `${base}?tab=${section}${query}`;
}
