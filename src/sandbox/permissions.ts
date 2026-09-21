import type { RoleCode, SandboxState, ScreenId } from './types';

export type Permission =
  | 'finding.create'
  | 'finding.edit'
  | 'workpaper.prepare'
  | 'workpaper.review'
  | 'workpaper.approve'
  | 'action.update'
  | 'action.verify'
  | 'action.close'
  | 'report.generate'
  | 'report.read'
  | 'auditlog.read'
  | 'plan.edit';

const matrix: Record<RoleCode, ReadonlySet<Permission>> = {
  HEAD_OF_AUDIT: new Set([
    'finding.create','finding.edit','workpaper.prepare','workpaper.review','workpaper.approve',
    'action.update','action.verify','action.close','report.generate','report.read','auditlog.read','plan.edit',
  ]),
  AUDIT_MANAGER: new Set([
    'finding.create','finding.edit','workpaper.prepare','workpaper.review','workpaper.approve',
    'action.update','action.verify','report.generate','report.read','auditlog.read','plan.edit',
  ]),
  SENIOR_AUDITOR: new Set([
    'finding.create','finding.edit','workpaper.prepare','workpaper.review',
    'action.update','action.verify','report.generate','report.read','auditlog.read',
  ]),
  AUDITOR: new Set([
    'finding.create','finding.edit','workpaper.prepare','action.update','report.read',
  ]),
  BOARD_MEMBER: new Set(['report.read']),
  UNIT_MANAGER: new Set(['action.update']),
};

export function canRole(role: RoleCode, permission: Permission): boolean {
  return matrix[role].has(permission);
}

export function can(state: SandboxState, permission: Permission, ownerIds: string[] = []): boolean {
  if (!canRole(state.activeRoleCode, permission)) return false;
  if (state.activeRoleCode !== 'UNIT_MANAGER') return true;
  return ownerIds.includes(state.activeUserId);
}

export function missingPermission(permission: Permission): string {
  const labels: Record<Permission,string> = {
    'finding.create':'Auditor finding creation',
    'finding.edit':'Auditor finding edit',
    'workpaper.prepare':'Work-paper preparation',
    'workpaper.review':'Reviewer sign-off',
    'workpaper.approve':'Chief Audit Executive approval',
    'action.update':'Action-plan ownership',
    'action.verify':'Auditor verification',
    'action.close':'Chief Audit Executive closure',
    'report.generate':'Audit management report generation',
    'report.read':'Committee-report access',
    'auditlog.read':'Audit-log access',
    'plan.edit':'Audit-plan scheduling',
  };
  return labels[permission];
}

export function roleScopeLabel(role: RoleCode): string {
  if (role === 'BOARD_MEMBER') return 'Read-only reports';
  if (role === 'UNIT_MANAGER') return 'Own actions only';
  if (role === 'HEAD_OF_AUDIT') return 'Full audit administration';
  if (role === 'AUDIT_MANAGER') return 'Review and audit management';
  if (role === 'SENIOR_AUDITOR') return 'Create, edit and review';
  return 'Create and edit audit work';
}

export function canAccessScreen(role: RoleCode, screen: ScreenId): boolean {
  if (role === 'BOARD_MEMBER') return screen === 'reports';
  if (role === 'UNIT_MANAGER') return screen === 'actions';
  return true;
}
