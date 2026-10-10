-- Multi-repo workspaces, step 4 (internal/store/session): the user pinned the thread
-- (SessionService.Pin, session.pin). Pinned threads sit at the top of the GUI's flat
-- thread list. Existing rows are unpinned.
ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
