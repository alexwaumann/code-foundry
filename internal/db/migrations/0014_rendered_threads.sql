-- Rendered threads (internal/store/session, docs/notes/rendered-threads-1-daemon.md).
-- render mirrors codefoundry.v1.SessionRender: 1 terminal (Claude in a PTY), 2 rendered
-- (claude -p over stream-json, conversation drawn by the GUI). Fixed for a thread's
-- life. Existing rows are terminal threads.
ALTER TABLE sessions ADD COLUMN render INTEGER NOT NULL DEFAULT 1;

-- A rendered thread's conversation, appended from the stream: one row per item
-- (user message, assistant text, thinking, tool call, permission request, question,
-- turn end, error, compaction, command output), ordered by ordinal. Ordinals are
-- assigned when an item first appears and only grow; an item still streaming is kept
-- in memory and written once complete, then rewritten in place when it changes (a
-- tool call's result, a permission's decision). data is the kind's payload as JSON.
CREATE TABLE thread_items (
    session_id         TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    ordinal            INTEGER NOT NULL,
    item_id            TEXT NOT NULL,
    kind               TEXT NOT NULL,
    parent_tool_use_id TEXT NOT NULL,  -- '' for the thread's own items; the Agent tool_use for a subagent's
    created_at         INTEGER NOT NULL, -- unix ms
    updated_at         INTEGER NOT NULL,
    data               TEXT NOT NULL,
    PRIMARY KEY (session_id, ordinal),
    UNIQUE (session_id, item_id)
) STRICT;
