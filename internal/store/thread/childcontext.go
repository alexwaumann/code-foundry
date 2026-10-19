package thread

import (
	"os"
	"path/filepath"
	"slices"
)

// What every thread's claude gets for orchestration besides its conversation
// (docs/notes/orch-child-context.md): the protocol commands pre-allowed, and its own
// TMPDIR.

// ProtocolAllowedTools are the permission rules every thread's claude gets as
// --allowedTools: the Code Foundry verbs an orchestrated child runs as part of the
// protocol (its report, and reading threads and projects), so a supervised thread does
// not ask its orchestrator, an Opus turn each, before them (E3/W2 of the 2026-10-19
// battle test). Read-only verbs and report only; anything that changes another thread
// or a project still asks. Every spawn, whatever the mode: a live switch to supervised
// (SetPermissionMode) keeps the process, and so its rules. Plain --allowedTools: a
// managed settings file that allows only managed rules (allowManagedPermissionRulesOnly)
// ignores them, and the thread asks as before.
var ProtocolAllowedTools = []string{
	"Bash(code-foundry thread report:*)",
	"Bash(code-foundry thread reports:*)",
	"Bash(code-foundry thread get:*)",
	"Bash(code-foundry thread list:*)",
	"Bash(code-foundry thread read:*)",
	"Bash(code-foundry project list:*)",
}

// allowedTools is a spawn's --allowedTools: the protocol rules, then what the
// conversation's allow-for-thread answers granted (an effort restart's), without
// repeats.
func allowedTools(granted []string) []string {
	out := slices.Clone(ProtocolAllowedTools)
	for _, g := range granted {
		if !slices.Contains(out, g) {
			out = append(out, g)
		}
	}
	return out
}

// threadTmp is thread id's TMPDIR under root (Options.TmpRoot): its claude, and every
// command Claude runs, writes its scratch files there instead of the machine's shared
// /tmp names (children wrote /tmp/bench.txt side by side, E4). "" without a root.
func threadTmp(root, id string) string {
	if root == "" || id == "" {
		return ""
	}
	return filepath.Join(root, id)
}

// tmpEnv makes thread id's TMPDIR and returns its environment entry; nil, with a
// warning, when it cannot be made (the process keeps the daemon's TMPDIR).
func (m *Manager) tmpEnv(id string) []string {
	dir := threadTmp(m.opts.TmpRoot, id)
	if dir == "" {
		return nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		m.log.Warn("create thread TMPDIR; keeping the daemon's", "thread", id, "dir", dir, "err", err)
		return nil
	}
	return []string{"TMPDIR=" + dir}
}

// removeThreadTmp removes thread id's TMPDIR (Remove, once its process is gone).
func (m *Manager) removeThreadTmp(id string) {
	dir := threadTmp(m.opts.TmpRoot, id)
	if dir == "" {
		return
	}
	if err := os.RemoveAll(dir); err != nil {
		m.log.Warn("remove thread TMPDIR", "thread", id, "dir", dir, "err", err)
	}
}

// reapThreadTmps removes the TMPDIRs of threads that no longer exist (removed while the
// daemon was down, or a removal that failed to delete it), at New.
func (m *Manager) reapThreadTmps() {
	if m.opts.TmpRoot == "" {
		return
	}
	entries, err := os.ReadDir(m.opts.TmpRoot)
	if err != nil {
		if !os.IsNotExist(err) {
			m.log.Warn("read threads' TMPDIR root", "dir", m.opts.TmpRoot, "err", err)
		}
		return
	}
	n := 0
	for _, e := range entries {
		if _, ok := m.recs[e.Name()]; ok {
			continue
		}
		if err := os.RemoveAll(filepath.Join(m.opts.TmpRoot, e.Name())); err != nil {
			m.log.Warn("remove a gone thread's TMPDIR", "dir", e.Name(), "err", err)
			continue
		}
		n++
	}
	if n > 0 {
		m.log.Info("removed the TMPDIRs of threads that are gone", "count", n)
	}
}
