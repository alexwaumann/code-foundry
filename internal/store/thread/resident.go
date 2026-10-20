package thread

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

// Resident threads (docs/notes/ember-1-primitives.md): the daemon's own long-lived agent
// threads, one per name ("ember"), made only by EnsureResident. A resident thread is an
// ordinary headless thread otherwise (a message starts it, it stops at its cache expiry,
// Reseed gives it fresh sessions), with these differences: it has no project or
// worktree (it runs in a directory of its own, which EnsureResident makes); it is never
// auto-named; Archive, Snooze, Remove and Fork refuse it (ErrFailedPrecondition), so the
// hidden-children cascade and the archive logic never stop it; a filtered List leaves it
// out unless ListOptions.IncludeResident or All asks; and clients keep it out of the
// user's lists. Threads it creates (thread.new from inside it) are its children as
// usual.

// ThreadKind is what kind of thread a Thread is. Values mirror codefoundry.v1.ThreadKind.
type ThreadKind int

// Thread kinds.
const (
	// KindNormal is every thread but a resident one.
	KindNormal ThreadKind = iota
	// KindResident is a resident thread (EnsureResident).
	KindResident
)

func (k ThreadKind) valid() bool { return k == KindNormal || k == KindResident }

// residentNamePattern is a resident's name: lowercase, a letter first.
var residentNamePattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)

// ResidentOptions configures the resident EnsureResident makes. They apply only when it
// makes one: an existing resident is returned as it is (SetModel, SetEffort,
// SetPermissionMode, Rename and Reseed change it).
type ResidentOptions struct {
	// Cwd is the absolute directory the resident runs in; EnsureResident makes it.
	Cwd string
	// SystemPromptAppend and AddDirs are its first seed (Thread.SystemPromptAppend,
	// SpawnAddDirs), as Reseed sets them.
	SystemPromptAppend string
	AddDirs            []string
	Model, Effort      string
	PermissionMode     PermissionMode
	// DisplayName is its name in the GUI; the resident name when empty.
	DisplayName string
	// Prefix starts the first message of its first session, as a reseed's does.
	Prefix string
}

// EnsureResident returns the resident thread named name, making it when there is none:
// stopped (no Claude process runs until a message is sent), with no project, in
// o.Cwd, which it creates. created says whether it made it.
func (m *Manager) EnsureResident(ctx context.Context, name string, o ResidentOptions) (t Thread, created bool, err error) {
	if !residentNamePattern.MatchString(name) {
		return Thread{}, false, fmt.Errorf("%w: resident name %q: want lowercase letters, digits and -, a letter first", ErrInvalidArgument, name)
	}
	if t, ok := m.resident(name); ok {
		return t, false, nil
	}
	if err := validateModelEffort(o.Model, o.Effort); err != nil {
		return Thread{}, false, err
	}
	if !o.PermissionMode.valid() {
		return Thread{}, false, fmt.Errorf("%w: permission mode %d", ErrInvalidArgument, o.PermissionMode)
	}
	display, err := cleanName(o.DisplayName, true)
	if err != nil {
		return Thread{}, false, err
	}
	if display == "" {
		display = name
	}
	seed, err := cleanSeed(o.SystemPromptAppend, o.AddDirs, o.Prefix)
	if err != nil {
		return Thread{}, false, err
	}
	if !filepath.IsAbs(o.Cwd) {
		return Thread{}, false, fmt.Errorf("%w: a resident's cwd must be an absolute path, not %q", ErrInvalidArgument, o.Cwd)
	}
	cwd := filepath.Clean(o.Cwd)
	if err := os.MkdirAll(cwd, 0o700); err != nil {
		return Thread{}, false, fmt.Errorf("thread: resident %s: make its directory: %w", name, err)
	}
	id, err := newThreadID()
	if err != nil {
		return Thread{}, false, err
	}
	now := m.opts.Now()
	s := Thread{
		ID: id, Kind: KindResident, ResidentName: name, Name: display, WorktreePath: cwd,
		Model: o.Model, Effort: o.Effort, PermissionMode: o.PermissionMode,
		State: StateDisconnected, Status: StatusIdle, StatusChangedAt: now, CreatedAt: now, LastActivityAt: now, Epoch: 1,
		SystemPromptAppend: seed.prompt, SpawnAddDirs: seed.dirs, SeedPrefix: seed.prefix, FreshStart: true,
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Thread{}, false, ErrClosed
	}
	for _, rec := range m.recs {
		if rec.s.Kind == KindResident && rec.s.ResidentName == name {
			return rec.s, false, nil // made meanwhile
		}
	}
	if err := saveThread(ctx, m.opts.DB, s); err != nil {
		return Thread{}, false, err
	}
	// Named for good: the namer never runs for it (namingTried).
	m.recs[id] = &record{s: s, namingTried: true}
	m.commitLocked(m.recs[id], false)
	m.log.Info("resident thread created", "thread", id, "resident", name, "cwd", cwd)
	return s, true, nil
}

// resident returns the resident thread named name.
func (m *Manager) resident(name string) (Thread, bool) {
	snap := m.Snapshot()
	if snap == nil {
		return Thread{}, false
	}
	i := slices.IndexFunc(snap.Threads, func(t Thread) bool { return t.Kind == KindResident && t.ResidentName == name })
	if i < 0 {
		return Thread{}, false
	}
	return snap.Threads[i], true
}

// refuseResident is the error of an action a resident thread does not take (archive,
// snooze, remove, fork); nil for any other thread, and for one that is not there (the
// action says so itself).
func (m *Manager) refuseResident(id, action string) error {
	t, ok := m.Snapshot().Thread(id)
	if !ok || t.Kind != KindResident {
		return nil
	}
	return fmt.Errorf("%w: thread %s is the resident %s thread; it cannot be %s", ErrFailedPrecondition, id, t.ResidentName, action)
}

// residentMatches reports whether a thread of kind k is in the list o asks for.
func (o ListOptions) residentMatches(k ThreadKind) bool {
	return k != KindResident || o.IncludeResident || o.All
}

// seed is a thread's validated seed (cleanSeed).
type seed struct {
	prompt string
	dirs   []string
	prefix string
}

// Seed bounds: the system prompt append goes on claude's command line.
const (
	maxSystemPromptAppend = 64 << 10
	maxSeedPrefix         = 256 << 10
)

// cleanSeed validates a seed: the system prompt append and the prefix within their
// bounds and without NUL, the add-dirs absolute (cleaned, each once).
func cleanSeed(prompt string, dirs []string, prefix string) (seed, error) {
	switch {
	case len(prompt) > maxSystemPromptAppend:
		return seed{}, fmt.Errorf("%w: the system prompt append has %d bytes (at most %d)", ErrInvalidArgument, len(prompt), maxSystemPromptAppend)
	case len(prefix) > maxSeedPrefix:
		return seed{}, fmt.Errorf("%w: the prefix has %d bytes (at most %d)", ErrInvalidArgument, len(prefix), maxSeedPrefix)
	case strings.ContainsRune(prompt, 0) || strings.ContainsRune(prefix, 0):
		return seed{}, fmt.Errorf("%w: the seed contains a NUL byte", ErrInvalidArgument)
	}
	var out []string
	for _, d := range dirs {
		if d = strings.TrimSpace(d); d == "" {
			continue
		}
		if !filepath.IsAbs(d) {
			return seed{}, fmt.Errorf("%w: add-dir %q is not an absolute path", ErrInvalidArgument, d)
		}
		if d = filepath.Clean(d); !slices.Contains(out, d) {
			out = append(out, d)
		}
	}
	return seed{prompt: strings.TrimSpace(prompt), dirs: out, prefix: strings.TrimSpace(prefix)}, nil
}
