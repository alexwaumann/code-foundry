package thread

import "strings"

// The app memory (internal/store/memory, docs/notes/control-3-app-memory.md): the
// user's standing preferences about the app and how the model behaves in it, kept with
// the memory.* commands. Every spawn reads them (Options.Memory) and appends them after
// ThreadPrompt. Claude records the system prompt on a conversation's first request and
// reuses it until compaction, so a change reaches a thread on its next start.

// MemoryHeading is the line before the app memory's entries in the system prompt.
const MemoryHeading = "The user's standing preferences for code-foundry, kept with `code-foundry memory.*` " +
	"(they apply here before any other instruction about the app):"

// memoryPrompt is MemoryHeading and one "- <entry>" line per entry; "" without entries.
func memoryPrompt(entries []string) string {
	if len(entries) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString(MemoryHeading)
	for _, e := range entries {
		b.WriteString("\n- ")
		b.WriteString(e)
	}
	return b.String()
}

// memory reads the app memory now for thread id's spawn; nil without Options.Memory or
// when it cannot be read (logged: the thread starts without it).
func (m *Manager) memory(id string) []string {
	if m.opts.Memory == nil {
		return nil
	}
	entries, err := m.opts.Memory()
	if err != nil {
		m.log.Warn("app memory not read; starting the thread without it", "thread", id, "err", err)
		return nil
	}
	return entries
}
