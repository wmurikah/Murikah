import { initialSchema } from './001_initial_schema.ts';
import { liveSchemaReconciliation } from './002_live_schema_reconciliation.ts';
import { passwordSessionVersion } from './003_password_session_version.ts';
import { authRecoveryAndMfa } from './004_auth_recovery_and_mfa.ts';

export const migrations = [
  initialSchema,
  liveSchemaReconciliation,
  passwordSessionVersion,
  authRecoveryAndMfa,
];
