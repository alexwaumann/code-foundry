package command

import v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"

// A thread whose transcript Claude Code deleted (Thread.transcript_missing,
// docs/notes/transcript-deleted.md) cannot continue: thread.list marks it, thread.get
// says so and what is left to do. The verbs that would run Claude (send, fork, mcp,
// mcp-reconnect, commands) get the daemon's FAILED_PRECONDITION and print its words.

// transcriptMissingMark is thread.list's mark.
const transcriptMissingMark = "transcript deleted"

// transcriptMissingLine is thread.get's line, "" for a thread that can continue.
func transcriptMissingLine(s *v1.Thread) string {
	if !s.GetTranscriptMissing() {
		return ""
	}
	return "transcript deleted: Claude Code removed this thread's transcript (cleanupPeriodDays), so it cannot continue; " +
		"archive or remove it"
}
