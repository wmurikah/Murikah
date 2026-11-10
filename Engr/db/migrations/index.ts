import { initialSchema } from './001_initial_schema.ts';
import { liveSchemaReconciliation } from './002_live_schema_reconciliation.ts';
import { passwordSessionVersion } from './003_password_session_version.ts';
import { authRecoveryAndMfa } from './004_auth_recovery_and_mfa.ts';
import { sessionAndLoginSecurity } from './005_session_and_login_security.ts';
import { comprehensiveRbac } from './006_comprehensive_rbac.ts';
import { queryIndexes } from './007_query_indexes.ts';

export const migrations = [
  initialSchema,
  liveSchemaReconciliation,
  passwordSessionVersion,
  authRecoveryAndMfa,
  sessionAndLoginSecurity,
  comprehensiveRbac,
  queryIndexes,
];
