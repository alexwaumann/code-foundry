-- The head branch of a 'branch' link (docs/notes/linked-prs-default-branch.md): the
-- branch the daemon matched it on. '' for every row before this, and for 'claude' and
-- 'child' rows. A 'branch' row with '' is resolved once by the daemon: dropped (with its
-- 'child' copies up the CreatedBy chain) when its pull request's head is the project's
-- default branch, else given its head.
ALTER TABLE thread_pull_requests ADD COLUMN head TEXT NOT NULL DEFAULT '';
