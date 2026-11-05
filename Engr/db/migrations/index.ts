import { initialSchema } from './001_initial_schema.ts';
import { liveSchemaReconciliation } from './002_live_schema_reconciliation.ts';

export const migrations = [initialSchema, liveSchemaReconciliation];
