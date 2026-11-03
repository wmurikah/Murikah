-- Signed interdepartmental SLA reconciliation
--
-- Source: "Interdepartmental Service Level Agreement" supplied as a signed
-- scan. The agreement sets Finance and Credit approvals at 15 minutes and
-- the PO approval departments at 30 minutes. Warning thresholds are internal
-- operational alerts five minutes before the contractual target; they are
-- not terms stated in the signed document.
--
-- The signed 10-minute LA-generation target starts when Customer Service
-- receives funds (cash customer) or an LPO (credit customer). The current SO
-- extract has the LA completion timestamp but not that receipt timestamp.
-- SLAR-SO-LA is therefore retained for history and set to the contractual
-- value, but kept inactive until the start event is captured. Activating it
-- now would judge order-to-LA time against a receipt-to-LA promise.
--
-- No BEGIN/COMMIT statements appear here. Turso Drizzle Studio wraps all
-- statements in the SQL console in one transaction and rejects embedded
-- transaction keywords.

UPDATE sla_rules
   SET rule_name = 'SO finance approval — signed SLA',
       target_minutes = 15,
       warning_minutes = 10,
       escalation_after_minutes = 15,
       active = 1
 WHERE sla_rule_id = 'SLAR-003'
   AND entity_type = 'SALES_ORDER'
   AND stage_code = 'FINANCE_APPROVAL';

UPDATE sla_rules
   SET rule_name = 'SO credit approval — signed SLA',
       target_minutes = 15,
       warning_minutes = 10,
       escalation_after_minutes = 15,
       active = 1
 WHERE sla_rule_id = 'SLAR-004'
   AND entity_type = 'SALES_ORDER'
   AND stage_code = 'CREDIT_APPROVAL';

UPDATE sla_rules
   SET rule_name = 'LA generation — awaiting funds or LPO receipt timestamp',
       target_minutes = 10,
       warning_minutes = 5,
       escalation_after_minutes = 10,
       active = 0
 WHERE sla_rule_id = 'SLAR-SO-LA'
   AND entity_type = 'SALES_ORDER'
   AND stage_code = 'LOADING_AUTHORITY';

-- Keep the signed 30-minute target explicit and repair prior drift without
-- changing the legacy 180-minute rule retained for foreign-key history.
UPDATE sla_rules
   SET rule_name = 'PO approval target — signed SLA',
       target_minutes = 30,
       warning_minutes = 25,
       escalation_after_minutes = 30,
       active = 1
 WHERE sla_rule_id = 'SLAR-PO-30'
   AND entity_type = 'PURCHASE_ORDER';

-- Expected result:
-- SLAR-003   | FINANCE_APPROVAL  | 15 | 10 | 1
-- SLAR-004   | CREDIT_APPROVAL   | 15 | 10 | 1
-- SLAR-SO-LA | LOADING_AUTHORITY | 10 |  5 | 0
-- SLAR-PO-30 | NULL              | 30 | 25 | 1
SELECT sla_rule_id,
       entity_type,
       stage_code,
       target_minutes,
       warning_minutes,
       escalation_after_minutes,
       active
  FROM sla_rules
 WHERE sla_rule_id IN ('SLAR-003', 'SLAR-004', 'SLAR-SO-LA', 'SLAR-PO-30')
 ORDER BY sla_rule_id;
