package commandtest

import (
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/memory"
	"github.com/alexwaumann/code-foundry/internal/store/skill"
)

// Memory is a fake command.MemoryReader: Entries returns Texts numbered from 1, or Err.
type Memory struct {
	Texts []string
	Err   error
}

var _ command.MemoryReader = (*Memory)(nil)

// Entries returns Texts as entries.
func (f *Memory) Entries() ([]memory.Entry, error) {
	if f.Err != nil {
		return nil, f.Err
	}
	out := make([]memory.Entry, len(f.Texts))
	for i, t := range f.Texts {
		out[i] = memory.Entry{Index: i + 1, Text: t}
	}
	return out, nil
}

// SkillSnapshot is a fake command.SkillSnapshotter returning Snap (nil: none yet).
type SkillSnapshot struct {
	Snap *skill.Snapshot
}

var _ command.SkillSnapshotter = (*SkillSnapshot)(nil)

// Snapshot returns Snap.
func (f *SkillSnapshot) Snapshot() *skill.Snapshot { return f.Snap }
