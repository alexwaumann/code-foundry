// Package skill is the Skills marketplace store (docs/notes/skills-1-registry.md): the
// marketplaces Claude Code has (`claude plugin marketplace list`), each checkout read
// into plugin and skill entries (package marketplace), Browse's search over them, and
// what is installed: Claude Code's plugins (`claude plugin list`) and the skill
// directories in ~/.claude/skills and the disabled dir, joined with skill_installs. It
// publishes a Snapshot on the bus whenever it re-reads. It never clones: Refresh asks
// Claude Code to update its checkouts (`claude plugin marketplace update <name>`).
package skill

import (
	"cmp"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/skill/marketplace"
)

// Errors Entry returns, for errors.Is.
var (
	ErrNotFound  = errors.New("not found")
	ErrAmbiguous = errors.New("ambiguous")
)

// ExpectedMarketplace is the marketplace the Registries section names when Claude Code
// has none (an example of what to `claude plugin marketplace add`).
const ExpectedMarketplace = "ai-marketplace"

// Options configures a Store. DB, Claude, SkillsDir and DisabledDir are required.
type Options struct {
	DB     *sql.DB
	Claude Claude
	// Git reads the checkouts' history; default a *marketplace.Git running git from PATH.
	Git *marketplace.Git
	// SkillsDir is Claude Code's user skills directory (~/.claude/skills).
	SkillsDir string
	// DisabledDir holds disabled skills (<home>/skills/disabled).
	DisabledDir string
	Bus         *bus.Bus     // default: a private bus
	Log         *slog.Logger // default: slog.Default()
	Now         func() time.Time
}

// Registry is one marketplace Claude Code has, as last read.
type Registry struct {
	// Name, Source ("github", "git", "directory", …), Repo (owner/repo for github), URL
	// and Ref are `claude plugin marketplace list`'s; Dir is its installLocation.
	Name, Source, Repo, URL, Ref, Dir string
	// Owner is marketplace.json's owner.name.
	Owner string
	// Plugins and Skills count the entries read.
	Plugins, Skills int
	// Head is the checkout's HEAD ("" when it is not a git checkout); Shallow a
	// shallow clone, whose dates are the boundary commit's until Refresh deepens it.
	Head    string
	Shallow bool
	// ReadAt is when the checkout was last read; RefreshedAt when Claude Code last
	// updated it for us (zero: not since the daemon started).
	ReadAt, RefreshedAt time.Time
	// Err is why the last read or refresh failed; the entries are the last good read's.
	Err string
	// Issues are what the read skipped (package marketplace) and why dates are missing.
	Issues []string
}

// Snapshot is the store's state. It is immutable once published.
type Snapshot struct {
	// Epoch grows by one per published snapshot in this daemon's lifetime; an open
	// page re-reads (Search, Installed) when it changes.
	Epoch uint64
	// Registries are in `claude plugin marketplace list` order. Empty: Claude Code
	// has no marketplace (name ExpectedMarketplace as the one to add).
	Registries []Registry
	// Installed is sorted by name, then kind.
	Installed []Installed
	// Err is why the marketplaces could not be listed (claude missing, say); the
	// registries are the last good list's.
	Err string
	// PluginsErr is why installed plugins could not be listed.
	PluginsErr string

	catalogs map[string]*marketplace.Catalog // by registry name
}

// Event is published on the bus as bus.Publish[skill.Event].
type Event interface{ isSkillEvent() }

// Changed is published after every read, with the new snapshot's epoch.
type Changed struct{ Epoch uint64 }

func (Changed) isSkillEvent()   {}
func (*Snapshot) isSkillEvent() {}

// Store reads the marketplaces and the installed state.
type Store struct {
	opts Options
	log  *slog.Logger

	// refreshMu serializes Refresh (network); mu serializes Load and guards epoch.
	refreshMu  sync.Mutex
	mu         sync.Mutex
	epoch      uint64
	refreshed  map[string]time.Time // RefreshedAt by registry
	refreshErr map[string]string    // the last refresh's failure by registry
	snap       atomic.Pointer[Snapshot]
}

// New returns a Store with an empty snapshot; Load reads.
func New(opts Options) (*Store, error) {
	if opts.DB == nil || opts.Claude == nil || opts.SkillsDir == "" || opts.DisabledDir == "" {
		return nil, errors.New("skill: Options.DB, Claude, SkillsDir and DisabledDir are required")
	}
	if opts.Git == nil {
		opts.Git = &marketplace.Git{}
	}
	if opts.Bus == nil {
		opts.Bus = bus.New()
	}
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	s := &Store{opts: opts, log: opts.Log, refreshed: map[string]time.Time{}, refreshErr: map[string]string{}}
	s.snap.Store(&Snapshot{catalogs: map[string]*marketplace.Catalog{}})
	return s, nil
}

// Snapshot is the current state.
func (s *Store) Snapshot() *Snapshot { return s.snap.Load() }

// Registries are the marketplaces as last read.
func (s *Store) Registries() []Registry { return slices.Clone(s.Snapshot().Registries) }

// Installed is what is installed as last read.
func (s *Store) Installed() []Installed { return slices.Clone(s.Snapshot().Installed) }

// Search searches every registry's entries (marketplace.Search).
func (s *Store) Search(q marketplace.Query) marketplace.Result {
	return marketplace.Search(s.Snapshot().entries(), q)
}

// Entry finds the entry named name (case-sensitive, as Claude Code and the skills
// directory are) of kind ("" for either), in registry order. Two entries of one kind
// with the same name (two registries, or two tiers) resolve to the first. A bare name
// both a plugin and a skill have is ErrAmbiguous (an *AmbiguousError naming both);
// none is ErrNotFound.
func (s *Store) Entry(name string, kind marketplace.Kind) (marketplace.Entry, error) {
	var found []marketplace.Entry
	for _, k := range []marketplace.Kind{marketplace.KindPlugin, marketplace.KindSkill} {
		if kind != "" && kind != k {
			continue
		}
		for _, e := range s.Snapshot().entries() {
			if e.Kind == k && e.Name == name {
				found = append(found, e)
				break
			}
		}
	}
	switch len(found) {
	case 0:
		what := cmp.Or(string(kind), "plugin or skill")
		return marketplace.Entry{}, fmt.Errorf("no %s named %q in the marketplace: %w", what, name, ErrNotFound)
	case 1:
		return found[0], nil
	}
	return marketplace.Entry{}, &AmbiguousError{Name: name, Choices: found}
}

// AmbiguousError is a name both a plugin and a skill have.
type AmbiguousError struct {
	Name    string
	Choices []marketplace.Entry
}

func (e *AmbiguousError) Error() string {
	var kinds []string
	for _, c := range e.Choices {
		kinds = append(kinds, "--kind "+string(c.Kind))
	}
	return fmt.Sprintf("%q is both a plugin and a skill; choose one with %s", e.Name, strings.Join(kinds, " or "))
}

// Is reports ErrAmbiguous.
func (e *AmbiguousError) Is(target error) bool { return target == ErrAmbiguous }

// entries are every catalog's entries, in registry order.
func (snap *Snapshot) entries() []marketplace.Entry {
	var out []marketplace.Entry
	for _, r := range snap.Registries {
		if c := snap.catalogs[r.Name]; c != nil {
			out = append(out, c.Entries...)
		}
	}
	return out
}

// Load reads everything without the network: the marketplace list, each checkout
// (from the history cache while its HEAD is unchanged), the installed plugins and
// skills. It publishes the new snapshot. Failures are reported in the snapshot (the
// last good registries and catalogs stay); the returned error joins them.
func (s *Store) Load(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	prev := s.Snapshot()
	next := &Snapshot{catalogs: map[string]*marketplace.Catalog{}}
	var errs []error

	infos, err := listMarketplaces(ctx, s.opts.Claude)
	if err != nil {
		errs = append(errs, err)
		next.Err = err.Error()
		next.Registries = slices.Clone(prev.Registries)
		for name, c := range prev.catalogs {
			next.catalogs[name] = c
		}
	} else {
		for _, info := range infos {
			reg, cat, err := s.read(ctx, info, prev)
			if err != nil {
				errs = append(errs, err)
			}
			next.Registries = append(next.Registries, reg)
			if cat != nil {
				next.catalogs[info.Name] = cat
			}
		}
	}

	plugins, err := listPlugins(ctx, s.opts.Claude)
	if err != nil {
		errs = append(errs, err)
		next.PluginsErr = err.Error()
		next.Installed = slices.DeleteFunc(slices.Clone(prev.Installed), func(i Installed) bool { return i.Kind != marketplace.KindPlugin })
	} else {
		next.Installed = installedPlugins(plugins, next.catalogs)
	}
	recs, err := loadRecords(ctx, s.opts.DB)
	if err != nil {
		errs = append(errs, err)
	}
	next.Installed = append(next.Installed, installedSkills(s.opts.SkillsDir, s.opts.DisabledDir, recs, next.catalogs)...)
	sortInstalled(next.Installed)

	s.epoch++
	next.Epoch = s.epoch
	s.snap.Store(next)
	bus.Publish[Event](s.opts.Bus, Changed{Epoch: next.Epoch})
	return errors.Join(errs...)
}

// read reads one marketplace's checkout. A failed read keeps prev's catalog.
func (s *Store) read(ctx context.Context, info marketplaceInfo, prev *Snapshot) (Registry, *marketplace.Catalog, error) {
	reg := Registry{
		Name: info.Name, Source: info.Source, Repo: info.Repo, URL: info.URL, Ref: info.Ref, Dir: info.InstallLocation,
		RefreshedAt: s.refreshed[info.Name], Err: s.refreshErr[info.Name],
	}
	hist, herr := s.opts.Git.History(ctx, info.InstallLocation)
	if herr != nil {
		hist = nil
	}
	cat, err := marketplace.Read(info.InstallLocation, info.Name, hist)
	if err != nil {
		reg.Err = err.Error()
		if old := prev.catalogs[info.Name]; old != nil {
			fill(&reg, old)
			if i := slices.IndexFunc(prev.Registries, func(r Registry) bool { return r.Name == info.Name }); i >= 0 {
				reg.ReadAt = prev.Registries[i].ReadAt
			}
		}
		s.log.Warn("marketplace not read", "marketplace", info.Name, "dir", info.InstallLocation, "err", err)
		return reg, prev.catalogs[info.Name], err
	}
	switch {
	case errors.Is(herr, marketplace.ErrNotGit):
		cat.Issues = append(cat.Issues, "the checkout is not a git clone, so entries have no dates and skills offer no updates")
	case herr != nil:
		cat.Issues = append(cat.Issues, "the checkout's history could not be read, so entries have no dates: "+herr.Error())
		s.log.Warn("marketplace history not read", "marketplace", info.Name, "err", herr)
	case hist.Shallow:
		cat.Issues = append(cat.Issues, "the checkout is a shallow clone, so every entry dates from its last commit until Refresh fetches the history")
	}
	fill(&reg, cat)
	reg.ReadAt = s.opts.Now()
	return reg, cat, nil
}

func fill(reg *Registry, cat *marketplace.Catalog) {
	reg.Owner, reg.Head, reg.Shallow = cat.Owner, cat.Head, cat.Shallow
	reg.Plugins, reg.Skills = cat.Count(marketplace.KindPlugin), cat.Count(marketplace.KindSkill)
	reg.Issues = slices.Clone(cat.Issues)
}

// Refresh asks Claude Code to update every marketplace (`claude plugin marketplace
// update <name>`), fetches the full history of a shallow checkout (`git fetch
// --unshallow`, once: Claude Code clones with --depth 1, which would date every entry
// at the checkout's last commit), then Loads. It needs the network: it runs on the
// Refresh action and the hourly update tick, never on a read.
func (s *Store) Refresh(ctx context.Context) error {
	s.refreshMu.Lock()
	defer s.refreshMu.Unlock()
	infos, err := listMarketplaces(ctx, s.opts.Claude)
	if err != nil {
		s.mu.Lock()
		next := *s.Snapshot()
		next.Err = err.Error()
		s.epoch++
		next.Epoch = s.epoch
		s.snap.Store(&next)
		bus.Publish[Event](s.opts.Bus, Changed{Epoch: next.Epoch})
		s.mu.Unlock()
		return err
	}
	var errs []error
	results := map[string]string{}
	at := map[string]time.Time{}
	for _, info := range infos {
		if _, err := s.opts.Claude.Run(ctx, "plugin", "marketplace", "update", info.Name); err != nil {
			s.log.Warn("marketplace update failed", "marketplace", info.Name, "err", err)
			errs = append(errs, err)
			results[info.Name] = err.Error()
			continue
		}
		at[info.Name] = s.opts.Now()
		if h, err := s.opts.Git.History(ctx, info.InstallLocation); err == nil && h.Shallow {
			if err := s.opts.Git.Unshallow(ctx, info.InstallLocation); err != nil {
				s.log.Warn("marketplace history not fetched", "marketplace", info.Name, "err", err)
			} else {
				s.log.Info("marketplace history fetched", "marketplace", info.Name)
			}
		}
	}
	s.mu.Lock()
	for _, info := range infos {
		if msg, failed := results[info.Name]; failed {
			s.refreshErr[info.Name] = msg
		} else {
			delete(s.refreshErr, info.Name)
			s.refreshed[info.Name] = at[info.Name]
		}
	}
	s.mu.Unlock()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return errors.Join(append(errs, s.Load(ctx))...)
}
