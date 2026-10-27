package threadtest

import "github.com/alexwaumann/code-foundry/internal/store/thread"

// refuseTranscriptMissing is the Manager's rule for a thread whose transcript Claude
// Code deleted (the store's transcriptmissing.go): a stopped thread Put with
// TranscriptMissing refuses Send, Reconnect, Fork and the MCP and slash command queries
// with thread.ErrTranscriptMissing, recording the call and changing nothing.
func refuseTranscriptMissing(s thread.Thread) error {
	if s.TranscriptMissing && s.State == thread.StateDisconnected {
		return thread.ErrTranscriptMissing
	}
	return nil
}
