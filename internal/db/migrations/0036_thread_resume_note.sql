-- A thread's pending resume note (internal/store/thread/resumenote.go,
-- docs/notes/orch-child-context.md): after the budget stop, another thread's interrupt
-- or a daemon restart stopped its turn, the next message Claude gets starts with a line
-- saying so. JSON ({"cause":"budget","budget_usd":0.5,"at":...}); '' when none.
ALTER TABLE threads ADD COLUMN resume_note TEXT NOT NULL DEFAULT '';
