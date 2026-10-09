-- New-thread composer (internal/store/session): the permission mode a session runs
-- with (re-passed to claude on reconnect and fork; mirrors codefoundry.v1.PermissionMode:
-- 0 claude's default, 1 manual, 2 acceptEdits, 3 auto), and, when Create made the
-- session's worktree, the ref its branch was created from.
ALTER TABLE sessions ADD COLUMN permission_mode INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN base_ref TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN created_worktree INTEGER NOT NULL DEFAULT 0;
