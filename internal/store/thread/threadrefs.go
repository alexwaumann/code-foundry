package thread

import (
	"regexp"
	"strings"
)

// Thread references in a message.
//
// The GUI composer's thread tag (docs/notes/composer-thread-pr-tags.md) reaches the
// daemon as one bracketed line naming another thread by its Code Foundry id:
//
//	[Thread "Fix resize race" (id s-0123456789ab)]
//
// The id is ours, not Claude's session id, so Claude could not find that thread's
// conversation from it. rewriteThreadRefs completes each line with where to read it: the
// thread's transcript when Claude has written one, else the CLI verb that prints its
// items, and puts in the thread's current name:
//
//	[Thread "Fix resize race" (id s-0123456789ab); transcript: /Users/me/.claude/projects/-x/<session>.jsonl]
//	[Thread "Fix resize race" (id s-0123456789ab); inspect with: code-foundry thread read s-0123456789ab]
//
// An id the daemon does not know keeps the name as written and says so ("; not found").
// Anything else in brackets is left alone, so prose that happens to look similar but is
// not exactly this shape passes through.

// threadRefPattern matches the GUI's projection of a thread tag: a name without quotes,
// brackets or line breaks (the GUI cleans it), and a thread id.
var threadRefPattern = regexp.MustCompile(`\[Thread "([^"\[\]\r\n]*)" \(id ([A-Za-z0-9_-]{1,64})\)\]`)

// threadRef is what a thread reference resolves to.
type threadRef struct {
	// name is the thread's current name ("" keeps the name as written).
	name string
	// transcript is the Claude transcript's path; "" when none exists yet.
	transcript string
}

// cleanRefName is a name safe inside the line's quotes.
func cleanRefName(s string) string {
	s = strings.Map(func(r rune) rune {
		switch r {
		case '"', '[', ']', '\r', '\n':
			return ' '
		}
		return r
	}, s)
	return strings.Join(strings.Fields(s), " ")
}

// rewriteThreadRefs completes every thread reference in prompt (see above) with what
// lookup returns for its id. It also returns the ids lookup did not know, for the caller
// to log.
func rewriteThreadRefs(prompt string, lookup func(id string) (threadRef, bool)) (string, []string) {
	if !strings.Contains(prompt, `[Thread "`) {
		return prompt, nil
	}
	var unknown []string
	out := threadRefPattern.ReplaceAllStringFunc(prompt, func(m string) string {
		sub := threadRefPattern.FindStringSubmatch(m)
		name, id := sub[1], sub[2]
		ref, ok := lookup(id)
		if !ok {
			unknown = append(unknown, id)
			return `[Thread "` + name + `" (id ` + id + `); not found]`
		}
		if n := cleanRefName(ref.name); n != "" {
			name = n
		}
		head := `[Thread "` + name + `" (id ` + id + `); `
		if ref.transcript != "" {
			return head + "transcript: " + ref.transcript + "]"
		}
		return head + "inspect with: code-foundry thread read " + id + "]"
	})
	return out, unknown
}

// threadRefs resolves thread references against the current snapshot: the thread's
// name and, once Claude has written it, its transcript.
func (m *Manager) threadRefs(id string) (threadRef, bool) {
	s, ok := m.Snapshot().Thread(id)
	if !ok {
		return threadRef{}, false
	}
	ref := threadRef{name: s.Name}
	if s.ClaudeSessionID != "" && s.WorktreePath != "" {
		if p, ok := m.opts.Paths.transcriptPath(s.WorktreePath, s.ClaudeSessionID); ok {
			ref.transcript = p
		}
	}
	return ref, true
}

// rewriteThreadRefsLogged is rewriteThreadRefs over the snapshot, logging unknown ids.
func (m *Manager) rewriteThreadRefsLogged(threadID, prompt string) string {
	out, unknown := rewriteThreadRefs(prompt, m.threadRefs)
	if len(unknown) > 0 {
		m.log.Warn("thread references to unknown threads", "thread", threadID, "ids", unknown)
	}
	return out
}
