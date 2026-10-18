package plugin

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
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
// the session environment and flags) so the new package starts empty and asks for
// consent again. An empty origin (a row from before the column that the migration could
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

// inheritance is what a package taking name would inherit, in words; empty when
// nothing.
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

// takeover is a package of another origin claiming a name that has something to
// inherit.
type takeover struct {
	from string   // the origin the name's consent, secrets and data belong to
	what []string // what would be inherited, in words
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
	if err != nil || len(what) == 0 {
		return nil, err
	}
	t := &takeover{from: r.Origin, what: what}
	if !force {
		return nil, fmt.Errorf("%w: plugin %s came from %s, and a package from %s would inherit %s; "+
			"--force deletes them and starts it fresh (it asks for consent again), or run `code-foundry plugin uninstall %s --purge` first",
			ErrFailedPrecondition, name, originWords(r.Origin), originWords(origin), andList(what), name)
	}
	return t, nil
}

// claimLocked binds name to origin: after checkOrigin (same rules), a takeover with
// force deletes what the old origin's package left (purgeIdentity) and the row then
// records the new origin with no consent. It returns the takeover carried out (nil when
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
		if err := m.purgeIdentity(ctx, name); err != nil {
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
			e.logs.add("host", "", "taken over by "+originWords(origin)+": deleted "+andList(t.what))
		}
	}
	return t, nil
}

// purgeIdentity stops name's plugin and deletes what belongs to its origin: its secrets,
// its data dir, its session environment and flags (its threads are archived and its
// terminals closed). opMu held.
func (m *Manager) purgeIdentity(ctx context.Context, name string) error {
	var logs *logBuffer
	if e, ok := m.entry(name); ok {
		logs = e.logs
		m.stopActor(e, StateDisabled)
		m.unregister(name)
	}
	m.forget(ctx, name, logs)
	if _, err := m.purgeSecretsAndData(ctx, name); err != nil {
		return err
	}
	return nil
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
	return fmt.Sprintf("\nIt replaces the plugin %s from %s: %s will be deleted.", name, originWords(t.from), andList(t.what))
}

// andList joins words as "a, b and c".
func andList(words []string) string {
	if len(words) < 2 {
		return strings.Join(words, "")
	}
	return strings.Join(words[:len(words)-1], ", ") + " and " + words[len(words)-1]
}
