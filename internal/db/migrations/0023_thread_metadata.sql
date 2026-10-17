-- Thread metadata for agent-created threads (internal/store/thread/metadata.go,
-- docs/notes/agents-2-metadata.md). created_by is the id of the thread whose agent ran
-- thread.new ('' when the user made it; no foreign key: the creator may be removed) and
-- created_by_name that thread's display name then, kept verbatim. brief is the
-- creator's free text. labels is a JSON array of sorted, distinct label tokens. The
-- report is the thread's latest: report_status mirrors codefoundry.v1.ThreadReportStatus
-- (0 none, 1 done, 2 blocked, 3 failed, 4 progress), report_data a compacted JSON
-- object ('' for none), report_at unix milliseconds (0 for none). budget_usd is the
-- spending limit (0 for none); budget_hit_usd is the budget value the budget stop last
-- fired for (0 when armed), so a crossing fires once across daemon restarts. Existing
-- rows get none of them.
ALTER TABLE threads ADD COLUMN created_by TEXT NOT NULL DEFAULT '';
ALTER TABLE threads ADD COLUMN created_by_name TEXT NOT NULL DEFAULT '';
ALTER TABLE threads ADD COLUMN brief TEXT NOT NULL DEFAULT '';
ALTER TABLE threads ADD COLUMN labels TEXT NOT NULL DEFAULT '[]';
ALTER TABLE threads ADD COLUMN report_status INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN report_summary TEXT NOT NULL DEFAULT '';
ALTER TABLE threads ADD COLUMN report_data TEXT NOT NULL DEFAULT '';
ALTER TABLE threads ADD COLUMN report_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN budget_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN budget_hit_usd REAL NOT NULL DEFAULT 0;
