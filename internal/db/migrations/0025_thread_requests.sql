-- Idempotency keys of thread creation (internal/store/thread/requests.go,
-- docs/notes/agents-5-cli.md): a Create with a request id its creator used within the
-- last 24 hours returns the thread made the first time. creator is the creating thread's
-- id, '' for the user. created_at is unix milliseconds; rows older than 24 hours are
-- pruned. A removed thread forgets its keys (ON DELETE CASCADE).
CREATE TABLE thread_requests (
    creator    TEXT NOT NULL,
    request_id TEXT NOT NULL,
    thread_id  TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (creator, request_id)
) STRICT;

CREATE INDEX thread_requests_thread ON thread_requests (thread_id);
