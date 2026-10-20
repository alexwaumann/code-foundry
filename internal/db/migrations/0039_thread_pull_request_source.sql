-- Where a thread's linked pull request came from (internal/store/thread/prlink.go,
-- docs/notes/linked-prs-children.md): 'claude' for Claude's pr-link transcript record
-- (every row before this), 'child' for a link copied up from a thread this thread
-- created (CreatedBy, transitively), 'branch' reserved for a pull request whose head is
-- the thread's worktree branch. via_thread_id is the direct child a 'child' link came
-- through; '' otherwise. Stored now, not yet on the API.
ALTER TABLE thread_pull_requests ADD COLUMN source TEXT NOT NULL DEFAULT 'claude';
ALTER TABLE thread_pull_requests ADD COLUMN via_thread_id TEXT NOT NULL DEFAULT '';
