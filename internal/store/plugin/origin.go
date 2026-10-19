package plugin

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// Install identity (docs/notes/plugins-8-secrets-hardening.md). A plugin's consent, its
// secrets and its data dir are kept by name, so a second package with the same name
// would take them over: a release of another repository, another registry's entry, a
// dev link to another folder. The plugins row records the origin they belong to
// (migration 0033): "registry:<url>", "github:<owner/repo>" (lower case),
// "path:<folder>", or "manual:<package dir>" for a package put in plugins/ by hand and
// enabled. A package of another origin may take the name only when nothing would be
// inherited, or with force, which first deletes what there is (secrets, data, consent,
// the session environment and flags) and removes the old package's threads, so the new
// package starts empty and asks for consent again. An empty origin (a row from before the column that the migration could
// not attribute) binds to the first origin that claims it.

// KindManual is an origin kind only: a package put in plugins/ by hand.
const KindManual InstallKind = "manual"

// originOf is the origin of an install kind and source.
func originOf(kind InstallKind, source string) string {
	if kind == KindGitHub {
		source = strings.ToLower(source)
	}
	return string(kind) + ":" + source
}

// originWords says where an origin's package came from, for a message.
func originWords(origin string) string {
	kind, src, _ := strings.Cut(origin, ":")
	switch InstallKind(kind) {
	case KindRegistry:
		return "the registry " + src
	case KindGitHub:
		return "the releases of " + src
	case KindPath:
		return "the folder " + src
	case KindManual:
		return "a package put in " + src + " by hand"
	}
	return origin
}

// currentOrigin is the origin of the package now at name, for a row that has none yet:
// its install record's, else its dev link's folder, else the package dir. "" when there
// is no package. m.mu not held.
func (m *Manager) currentOrigin(name string) string {
	if rec, ok := m.inst.record(name); ok {
		return originOf(rec.Kind, rec.Source)
	}
	e, ok := m.entry(name)
	if !ok {
		return ""
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if e.dev {
		return originOf(KindPath, e.dir)
	}
	return originOf(KindManual, e.link)
}

// inheritance is what a package taking name would inherit and a takeover deletes, in
// words; empty when nothing. Its threads are counted apart (ownedThreads).
func (m *Manager) inheritance(ctx context.Context, name string, r row) ([]string, error) {
	var what []string
	if r.Granted != nil {
		what = append(what, "the consent you gave it")
	}
	secrets, err := listSecrets(ctx, m.opts.DB, name)
	if err != nil {
		return nil, err
	}
	if n := len(secrets); n > 0 {
		what = append(what, fmt.Sprintf("its %d secret(s) in the Keychain", n))
	}
	if ents, err := os.ReadDir(filepath.Join(m.opts.DataDir, name)); err == nil && len(ents) > 0 {
		what = append(what, "its data in "+filepath.Join(m.opts.DataDir, name))
	}
	return what, nil
}

// ownedThreads counts name's threads, archived ones too.
func (m *Manager) ownedThreads(name string) int {
	if m.opts.Threads == nil {
		return 0
	}
	return len(m.opts.Threads.Owned(OwnerOf(name)))
}

// takeover is a package of another origin claiming a name that has something to
// inherit.
type takeover struct {
	from string   // the origin the name's consent, secrets and data belong to
	what []string // what would be inherited and is deleted, in words
	// threads counts the old package's threads (a takeover removes them); removed are the
	// ids claimLocked removed.
	threads int
	removed []string
}

// inherits is everything the new package would inherit, in words.
func (t *takeover) inherits() string {
	w := t.what
	if t.threads > 0 {
		w = append(slices.Clone(w), threadsWords(t.threads))
	}
	return andList(w)
}

// done says what a carried-out takeover deleted and removed.
func (t *takeover) done() string {
	var w []string
	if len(t.what) > 0 {
		w = append(w, "deleted "+andList(t.what))
	}
	if len(t.removed) > 0 {
		w = append(w, "removed "+threadsWords(len(t.removed)))
	}
	if len(w) == 0 {
		return "nothing to delete"
	}
	return strings.Join(w, " and ")
}

// checkOrigin reports whether a package from origin may take name: nil when the origin
// is the same, unknown, or nothing would be inherited. Otherwise it is a takeover:
// without force an ErrFailedPrecondition saying what and how; with force the takeover
// to carry out (claimLocked).
func (m *Manager) checkOrigin(ctx context.Context, name, origin string, force bool) (*takeover, error) {
	rows, err := loadRows(ctx, m.opts.DB)
	if err != nil {
		return nil, err
	}
	r := rows[name]
	if r.Origin == "" || r.Origin == origin {
		return nil, nil
	}
	what, err := m.inheritance(ctx, name, r)
	if err != nil {
		return nil, err
	}
	t := &takeover{from: r.Origin, what: what, threads: m.ownedThreads(name)}
	if len(what) == 0 && t.threads == 0 {
		return nil, nil
	}
	if !force {
		return nil, fmt.Errorf("%w: plugin %s came from %s, and a package from %s would inherit %s; "+
			"--force deletes them and starts it fresh (it asks for consent again), or run `code-foundry plugin uninstall %s --purge` first",
			ErrFailedPrecondition, name, originWords(r.Origin), originWords(origin), t.inherits(), name)
	}
	return t, nil
}

// claimLocked binds name to origin: after checkOrigin (same rules), a takeover with
// force deletes what the old origin's package left and removes its threads
// (purgeIdentity), and the row then records the new origin with no consent. It returns the takeover carried out (nil when
// there was none). opMu held.
func (m *Manager) claimLocked(ctx context.Context, name, origin string, force bool) (*takeover, error) {
	t, err := m.checkOrigin(ctx, name, origin, force)
	if err != nil {
		return nil, err
	}
	rows, err := loadRows(ctx, m.opts.DB)
	if err != nil {
		return nil, err
	}
	r := rows[name]
	r.Name = name
	if t != nil {
		removed, err := m.purgeIdentity(ctx, name)
		t.removed = removed
		if err != nil {
			return nil, err
		}
		r.Enabled, r.Granted, r.ConsentedAt = false, nil, time.Time{}
		m.log.Warn("plugin taken over by another source", "plugin", name, "from", t.from, "to", origin)
	}
	if r.Origin == origin && t == nil {
		return nil, nil
	}
	r.Origin = origin
	if err := saveRow(ctx, m.opts.DB, r, m.opts.Now()); err != nil {
		return nil, err
	}
	m.update(name, nil, func(e *entry) { e.row = r })
	if t != nil {
		if e, ok := m.entry(name); ok {
			e.logs.add("host", "", "taken over by "+originWords(origin)+": "+t.done())
		}
	}
	return t, nil
}

// purgeIdentity stops name's plugin and deletes what belongs to its origin: its secrets,
// its data dir, its session environment and flags; its threads are removed (their ids
// returned) and its terminals closed. opMu held.
func (m *Manager) purgeIdentity(ctx context.Context, name string) ([]string, error) {
	var logs *logBuffer
	if e, ok := m.entry(name); ok {
		logs = e.logs
		m.stopActor(e, StateDisabled)
		m.unregister(name)
	}
	removed := m.discard(ctx, name, logs)
	if _, err := m.purgeSecretsAndData(ctx, name); err != nil {
		return removed, err
	}
	return removed, nil
}

// purgeSecretsAndData deletes name's recorded secrets (Keychain item, then row) and its
// data dir, and says what it deleted.
func (m *Manager) purgeSecretsAndData(ctx context.Context, name string) ([]string, error) {
	var purged []string
	secrets, err := listSecrets(ctx, m.opts.DB, name)
	if err != nil {
		return nil, err
	}
	for _, s := range secrets {
		if err := m.opts.Secrets.Delete(ctx, name, s.Key); err != nil {
			return purged, fmt.Errorf("plugin: purge secret %s: %w", s.Key, err)
		}
		if _, err := dropSecret(ctx, m.opts.DB, name, s.Key); err != nil {
			return purged, err
		}
		m.secretDeleted(name, s.Key) // (the callers stopped it first: nothing to tell)
	}
	if len(secrets) > 0 {
		purged = append(purged, fmt.Sprintf("%d secret(s) from the Keychain", len(secrets)))
	}
	dataDir := filepath.Join(m.opts.DataDir, name)
	if _, err := os.Stat(dataDir); err == nil {
		if err := os.RemoveAll(dataDir); err != nil {
			return purged, fmt.Errorf("plugin: purge %s: %w", dataDir, err)
		}
		purged = append(purged, "its data in "+dataDir)
	}
	return purged, nil
}

// takeoverConsent is the line a consent text gains when enabling carries out a takeover.
func takeoverConsent(name string, t *takeover) string {
	s := fmt.Sprintf("\nIt replaces the plugin %s from %s: ", name, originWords(t.from))
	switch {
	case len(t.what) > 0 && t.threads > 0:
		return s + andList(t.what) + " will be deleted, and it removes " + threadsWords(t.threads) + "."
	case t.threads > 0:
		return s + "it removes " + threadsWords(t.threads) + "."
	}
	return s + andList(t.what) + " will be deleted."
}

// andList joins words as "a, b and c".
func andList(words []string) string {
	if len(words) < 2 {
		return strings.Join(words, "")
	}
	return strings.Join(words[:len(words)-1], ", ") + " and " + words[len(words)-1]
}
