/**
 * The CMS line-icon set.
 *
 * Kept as data in a .ts module rather than inline in the component so the names
 * are a type: a typo in an icon key is a compile error, not a silently empty
 * glyph. CmsIcon.astro renders these; the navigation model imports the type.
 *
 * Every glyph is drawn on a 24x24 grid in currentColor with a stroke, no fill,
 * so it takes the colour of its context and stays crisp at any size. This
 * mirrors the engr and grc icon components, so the three products share one
 * visual idiom. No icon package is installed and none is added: an icon set is
 * a dependency decision for a worker that serves four products, not a local one.
 */
export const CMS_ICONS = {
  // Navigation
  home: '<path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/>',
  customers:
    '<circle cx="9" cy="8" r="3.2"/><path d="M2.5 20v-1a5 5 0 0 1 5-5h3a5 5 0 0 1 5 5v1M17 5a3.2 3.2 0 0 1 0 6.4M21.5 20v-1a4.6 4.6 0 0 0-3-4.3"/>',
  crm: '<path d="M3 20V9m5 11V4m5 16v-7m5 7V7"/><circle cx="8" cy="4" r="1.4"/><circle cx="18" cy="7" r="1.4"/>',
  service:
    '<path d="M21 11.5a8.4 8.4 0 0 1-12.1 7.6L3 21l1.9-5.9A8.4 8.4 0 1 1 21 11.5z"/><path d="M8.6 11.5h.01M12 11.5h.01M15.4 11.5h.01"/>',
  orders:
    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4"/>',
  performance: '<path d="M4 20V4M4 20h16M8 16l3.5-4.5 3 2L19 7"/><circle cx="19" cy="7" r="1.3"/>',
  data: '<ellipse cx="12" cy="6" rx="7.5" ry="3"/><path d="M4.5 6v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6M4.5 12v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6"/>',
  administration:
    '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M18.7 18.7l-1.6-1.6M6.9 6.9 5.3 5.3"/>',

  // Chrome and controls
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.9-4.9"/>',
  bell: '<path d="M18 8.8a6 6 0 0 0-12 0c0 6.4-2.8 8.2-2.8 8.2h17.6S18 15.2 18 8.8M13.7 20.5a2 2 0 0 1-3.4 0"/>',
  menu: '<path d="M3.5 6.5h17M3.5 12h17M3.5 17.5h17"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  chevronDown: '<path d="m6 9.5 6 6 6-6"/>',
  chevronRight: '<path d="m9.5 6 6 6-6 6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  filter: '<path d="M3.5 5.5h17l-6.5 7.6V20l-4-2v-4.9z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.2V12l3.2 2"/>',
  logout:
    '<path d="M14.5 4.5H19a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-4.5M10 8.5 6.5 12 10 15.5M6.5 12H16"/>',

  // Status. Never used alone: each sits beside its own word.
  statusOk: '<circle cx="12" cy="12" r="8.5"/><path d="m8.2 12.3 2.6 2.6 5-5.4"/>',
  statusWarn: '<path d="M12 3.8 21 19.5H3z"/><path d="M12 9.7v4.1M12 16.8h.01"/>',
  statusBreach: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.6v5M12 15.9h.01"/>',
  statusInfo: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11.2v5.2M12 7.9h.01"/>',

  // Password reveal
  eye: '<path d="M2 12s3.8-6.5 10-6.5S22 12 22 12s-3.8 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/>',
  eyeOff:
    '<path d="M9.6 5.7A9.9 9.9 0 0 1 12 5.5c6.2 0 10 6.5 10 6.5a17.6 17.6 0 0 1-3.4 4.1M6.2 7.9A17.4 17.4 0 0 0 2 12s3.8 6.5 10 6.5a9.8 9.8 0 0 0 3.3-.55M10 10.1a2.8 2.8 0 0 0 3.9 3.9M3.5 3.5l17 17"/>',
  /**
   * The assistant. A speech bubble rather than a star or a spark: this is a
   * conversation with a system that reads records, and the glyphs that mean
   * "magic" promise something the assistant deliberately does not do.
   */
  chat: '<path d="M20.5 12.2a7.7 7.7 0 0 1-8.3 7.7 8.6 8.6 0 0 1-2.6-.5L4.5 21l1.4-4.2a7.6 7.6 0 0 1-1.4-4.6 7.7 7.7 0 0 1 8-7.7 7.7 7.7 0 0 1 8 7.7Z"/>',
} as const;

export type CmsIconName = keyof typeof CMS_ICONS;
