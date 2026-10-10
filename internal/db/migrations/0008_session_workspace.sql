-- Multi-repo workspaces, step 2 (internal/store/session): a thread's owner. A non-empty
-- workspace_id makes the workspace the owner; empty means the project (repo_id). repo_id
-- and worktree_path stay facts about the cwd. Existing rows are project threads.
ALTER TABLE sessions ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '';
