package thread

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// The app memory (internal/store/memory, docs/notes/control-3-app-memory.md): the
// user's standing preferences about the app and how the model behaves in it, kept with
// the memory.* commands. Every spawn reads them (Options.Memory) and appends them after
// ThreadPrompt.
//
// Claude records the system prompt on a conversation's first request and reuses it on
// --resume, so only a fresh conversation (a create, a reseed, an Ember epoch) gets the
// memory as it is now. The row keeps a hash of the entries its conversation last got
// (Thread.MemoryHash): a fresh spawn sets it; a resumed one (a restart, a fork, a start
// on send) whose memory differs sends the whole list again before the next message
// Claude gets (memoryRefresh, runner.sendMessage), then takes the new hash
// (docs/notes/control-6-memory-fixes.md).

// MemoryHeading is the line before the app memory's entries in the system prompt.
const MemoryHeading = "What you remember about the user's standing preferences for code-foundry " +
	"(kept with `code-foundry memory show|add|remove`; the user asking what you remember, to remember something, " +
	"or to forget something means this list, not your own memory files):"

// MemoryRefreshHeading is the line before the entries a resumed conversation gets when
// the memory changed since it started; MemoryRefreshNone replaces the block when the
// memory is empty now.
const (
	MemoryRefreshHeading = "Updated standing preferences for code-foundry (replace the earlier list):"
	MemoryRefreshNone    = "Updated standing preferences for code-foundry: there are none now (forget the earlier list)."
)

// memoryPrompt is MemoryHeading and one "- <entry>" line per entry; "" without entries.
func memoryPrompt(entries []string) string {
	return memoryList(MemoryHeading, entries)
}

// memoryRefresh is the block a resumed conversation's next message starts with when the
// memory changed since the conversation got it.
func memoryRefresh(entries []string) string {
	if len(entries) == 0 {
		return MemoryRefreshNone
	}
	return memoryList(MemoryRefreshHeading, entries)
}

func memoryList(heading string, entries []string) string {
	if len(entries) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString(heading)
	for _, e := range entries {
		b.WriteString("\n- ")
		b.WriteString(e)
	}
	return b.String()
}

// memoryHash identifies the entries a conversation got: "" for none (also a row from
// before the hash was kept, so such a thread gets the list once the memory has any).
// Only the entries count: rewording a heading resends nothing.
func memoryHash(entries []string) string {
	if len(entries) == 0 {
		return ""
	}
	sum := sha256.Sum256([]byte(strings.Join(entries, "\n")))
	return hex.EncodeToString(sum[:8])
}

// spawnMemory is what a spawn did with the app memory (claudeCommand).
type spawnMemory struct {
	// entries were read now (nil when there are none or they could not be read).
	entries []string
	// fresh: a new conversation, whose system prompt has entries: the row takes hash.
	fresh bool
	// hash is memoryHash(entries); note, when set, is the refresh a resumed
	// conversation's next message starts with (the row takes hash once it went out).
	hash, note string
}

// memorySpawned is the app memory of a spawn under l: a fresh conversation has mem in
// its system prompt; a resumed one keeps the prompt it started with, whose entries'
// hash is had (the row's), so when mem differs its next message carries the new list.
// A memory that could not be read (ok false) changes nothing on a resumed one.
func memorySpawned(l launch, had string, mem []string, ok bool) spawnMemory {
	sm := spawnMemory{entries: mem, fresh: l.resume == "", hash: memoryHash(mem)}
	if !sm.fresh && ok && sm.hash != had {
		sm.note = memoryRefresh(mem)
	}
	return sm
}

// memory reads the app memory now for thread id's spawn; nil without Options.Memory,
// and not ok when it cannot be read (logged: the thread starts without it).
func (m *Manager) memory(id string) (entries []string, ok bool) {
	if m.opts.Memory == nil {
		return nil, true
	}
	entries, err := m.opts.Memory()
	if err != nil {
		m.log.Warn("app memory not read; starting the thread without it", "thread", id, "err", err)
		return nil, false
	}
	return entries, true
}

// memorySent records on thread id's row that its conversation has the memory of hash:
// the refresh carrying it went out.
func (m *Manager) memorySent(id, hash string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.recs[id]
	if !ok || rec.s.MemoryHash == hash {
		return
	}
	rec.s.MemoryHash = hash
	m.commitLocked(rec, true)
}
