-- A thread's name is provisional (internal/store/thread/provisional.go,
-- docs/notes/provisional-names.md): the daemon derived it from the first prompt and the
-- namer still replaces it; a rename or the namer's title clears it. Existing rows keep
-- their names as real ones.
ALTER TABLE threads ADD COLUMN name_provisional INTEGER NOT NULL DEFAULT 0;
