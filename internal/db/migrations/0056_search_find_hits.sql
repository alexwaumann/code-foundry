-- A Find entry's result count when it was recorded (docs/notes/search-6-agent-gui.md):
-- Recent searches shows it as "N hits". 0 for entries recorded before (not known).
ALTER TABLE search_history ADD COLUMN find_hits INTEGER NOT NULL DEFAULT 0;
