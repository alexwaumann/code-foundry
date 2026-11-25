package db

import _ "embed"

// LayoutWayBack is the SQL that takes a database back from migration 0061 (the window
// shell's layout) for a build from before the shell, which refuses a database recording a
// migration it does not know. It drops the layout's tables and the migration's record, and
// undoes the migrations after it (0062: projects' include patterns; 0063 and 0064: notifications;
// 0065: snoozes until an event; 0066: auto-tidy's state per thread; 0067 and 0068: pages' owners,
// consent and the storage carry-over; 0069: cached pull request diffs; 0070: project cold-start
// snapshot cache), and keeps everything
// else. It is run by hand, with the daemon stopped
// (docs/notes/shell-24a-import-moves.md, item 6); nothing in the daemon runs it.
//
//go:embed wayback/0061_layout.sql
var LayoutWayBack string
