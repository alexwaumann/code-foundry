package notification

import "strings"

// Look keys (docs/notes/waiting-thread-look.md): thread.look posts a thread's request for
// the user's eyes under SourceCommand with the key LookKey(thread), so a thread has at most
// one: posting again replaces it in place. The daemon withdraws it when the user sees the
// thread and when the thread's own turn ends needing the user (internal/daemon/thread_look.go).

// LookKeyPrefix starts every look key.
const LookKeyPrefix = "look:"

// LookKey is the key of thread id's request for the user's eyes.
func LookKey(threadID string) string { return LookKeyPrefix + threadID }

// ParseLookKey returns the thread a look key names; ok is false for any other key.
func ParseLookKey(key string) (threadID string, ok bool) {
	id, found := strings.CutPrefix(key, LookKeyPrefix)
	return id, found && id != ""
}
