-- The app memory's entries a thread's conversation last got (internal/store/thread/memory.go,
-- docs/notes/control-6-memory-fixes.md): a hash, set by a fresh spawn (its system prompt) and by
-- the refresh a resumed conversation's next message carries when the memory changed. '' for none.
ALTER TABLE threads ADD COLUMN memory_hash TEXT NOT NULL DEFAULT '';
