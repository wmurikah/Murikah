/**
 * The pure dropdown constants for the work-paper control fields: the config keys
 * and the standard default values seeded for every organisation. Kept import-free
 * (no database, no typed-column layer) so node can strip types and unit-test it,
 * and so the provisioning builder and seed can share one source of defaults. The
 * database-backed loaders and savers live in dropdowns.ts.
 */
export const DROPDOWN_KEYS = {
  riskRatings: 'DROPDOWN_RISK_RATINGS',
  classification: 'DROPDOWN_CONTROL_CLASSIFICATION',
  controlType: 'DROPDOWN_CONTROL_TYPE',
  controlFrequency: 'DROPDOWN_CONTROL_FREQUENCY',
} as const;

export type DropdownKey = (typeof DROPDOWN_KEYS)[keyof typeof DROPDOWN_KEYS];

export interface ControlDropdowns {
  riskRatings: string[];
  classification: string[];
  controlType: string[];
  controlFrequency: string[];
}

/** The standard values seeded for every organisation. Keep in step with the seed. */
export const DROPDOWN_DEFAULTS: ControlDropdowns = {
  riskRatings: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'],
  classification: ['KEY', 'SECONDARY', 'COMPENSATING'],
  controlType: ['PREVENTIVE', 'DETECTIVE', 'CORRECTIVE', 'DIRECTIVE'],
  controlFrequency: [
    'CONTINUOUS',
    'DAILY',
    'WEEKLY',
    'MONTHLY',
    'QUARTERLY',
    'SEMI_ANNUAL',
    'ANNUAL',
    'AD_HOC',
  ],
};
