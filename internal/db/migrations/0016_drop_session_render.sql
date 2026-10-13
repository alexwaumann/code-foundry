-- Rendered is the only thread mode (docs/notes/rendered-only-daemon.md): the render
-- column of 0014 goes. Rows that were terminal threads open as rendered threads with
-- empty history; thread_items stays.
ALTER TABLE sessions DROP COLUMN render;
