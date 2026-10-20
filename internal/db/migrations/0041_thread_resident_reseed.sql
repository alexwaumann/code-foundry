-- Resident threads and reseeds (internal/store/thread/resident.go and reseed.go,
-- docs/notes/ember-1-primitives.md). kind is 1 for a resident thread, the daemon's own
-- long-lived agent, named by resident_name (one per name); 0 for every other thread.
-- epoch counts a thread's Claude sessions (1, plus one per reseed). A reseed sets
-- system_prompt_append (every spawn's), fresh_start (the next spawn starts a new
-- conversation; cleared by it) and seed_prefix (the first message of that conversation
-- starts with it; cleared once it went out). Existing rows are ordinary threads in their
-- first epoch.
ALTER TABLE threads ADD COLUMN kind INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN resident_name TEXT NOT NULL DEFAULT '';
ALTER TABLE threads ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1;
ALTER TABLE threads ADD COLUMN system_prompt_append TEXT NOT NULL DEFAULT '';
ALTER TABLE threads ADD COLUMN fresh_start INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN seed_prefix TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX threads_resident_name ON threads (resident_name) WHERE resident_name != '';
