/**
 * The tab model for Administration → Workflows.
 *
 * Data rather than markup, the same shape as ./workspace.ts, and for the same
 * reason: a tab is a real URL, so it can be bookmarked, opened in a new browser
 * tab and survives a reload with no client-side state.
 */
export const WORKFLOW_PATH = '/app/administration/workflows';

export type WorkflowTabKey = 'roles' | 'definitions' | 'preview';

export interface WorkflowTab {
  readonly key: WorkflowTabKey;
  readonly label: string;
  readonly summary: string;
}

export const WORKFLOW_TABS: readonly WorkflowTab[] = [
  {
    key: 'roles',
    label: 'Workflow roles',
    summary:
      'Who may approve, for which part of the organisation, and up to what value. A workflow role is not an access role: it says what a person may approve, not what they may open.',
  },
  {
    key: 'definitions',
    label: 'Definitions',
    summary:
      'The stages a transaction goes through, versioned. A version that records are already running under is superseded by a new version, never edited.',
  },
  {
    key: 'preview',
    label: 'Approval preview',
    summary:
      'Ask who would approve a transaction before one exists. It calls the same resolver as the live path, so what it shows is what will happen.',
  },
];

export function resolveWorkflowTab(raw: string | null): WorkflowTab {
  const found = WORKFLOW_TABS.find((tab) => tab.key === raw);
  return found ?? (WORKFLOW_TABS[0] as WorkflowTab);
}

export function workflowTabHref(key: WorkflowTabKey): string {
  return `${WORKFLOW_PATH}?tab=${key}`;
}

/**
 * The label an approval mode gets in the interface.
 *
 * Written here rather than in a template so the definition screen, the stage
 * detail and the preview describe a mode the same way. The value itself always
 * comes from the row; this only decides how it reads.
 */
export const APPROVAL_MODE_LABELS: Readonly<Record<string, string>> = {
  ANY_ONE: 'Any one approver',
  ALL: 'Every approver',
  SEQUENTIAL: 'In sequence',
  ROUND_ROBIN: 'Round robin',
  NAMED: 'A named person',
  SYSTEM: 'Automatic',
};

export const ASSIGNMENT_TYPE_LABELS: Readonly<Record<string, string>> = {
  USER: 'A named person',
  WORKFLOW_ROLE: 'A workflow role',
  TEAM: 'A team',
  SYSTEM: 'The system',
};

export const SCOPE_LABELS: Readonly<Record<string, string>> = {
  BUSINESS_UNIT: 'Business unit',
  AFFILIATE: 'Affiliate',
  COUNTRY: 'Country',
  GROUP: 'Group',
};

/**
 * How a mode and `required_approvals` read together, in one sentence.
 *
 * The two columns interact, and where they disagree the screen says which one
 * wins rather than showing both numbers and leaving the operator to guess.
 */
export function describeApproval(mode: string, requiredApprovals: number): string {
  switch (mode) {
    case 'ANY_ONE':
      return requiredApprovals > 1
        ? `Any ${requiredApprovals} of the eligible approvers.`
        : 'Any one of the eligible approvers.';
    case 'ALL':
      return requiredApprovals > 1
        ? 'Every assignee must approve. The required count is recorded and does not override that.'
        : 'Every assignee must approve.';
    case 'SEQUENTIAL':
      return 'Each assignee approves in turn, in the order they were assigned.';
    case 'ROUND_ROBIN':
      return 'One eligible approver is chosen fairly and the choice is kept.';
    case 'NAMED':
      return 'The person named on the stage.';
    case 'SYSTEM':
      return 'No human approver. The stage completes automatically.';
    default:
      return '';
  }
}
