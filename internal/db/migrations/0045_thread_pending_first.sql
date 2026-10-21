-- A thread's first message until Claude has it (internal/store/thread/firstprompt.go,
-- docs/notes/ember-fixes-2-wakes.md): written with the row before claude starts, cleared
-- once the message went out, so a daemon stop before the handshake does not lose it; the
-- next start delivers it first. JSON ({"text":...,"prompt":...}); '' when none.
ALTER TABLE threads ADD COLUMN pending_first TEXT NOT NULL DEFAULT '';
