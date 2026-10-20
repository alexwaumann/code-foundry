package skill

import (
	"cmp"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/skill/marketplace"
	"github.com/alexwaumann/code-foundry/internal/store/update"
)

// Installed is a plugin or skill on this Mac: a plugin `claude plugin list` reports, or
// a skill directory in ~/.claude/skills or the disabled dir (with or without a record),
// or a record whose directory is gone.
type Installed struct {
	Kind marketplace.Kind
	Name string
	// Registry is the marketplace it came from; "" for a local skill.
	Registry string
	// Path is a recorded skill's repo-relative directory in Registry (the entry it
	// updates from); a plugin's index entry's path when the marketplace is read.
	Path string
	Tier marketplace.Tier
	// Description is the installed SKILL.md's (a skill), the index entry's (a plugin).
	Description string
	// By is who it is by: the marketplace entry's (plugin.json author, the skill's
	// frontmatter owner), else the installed SKILL.md's.
	By string
	// Version is a plugin's installed version (Claude Code's; a commit prefix when the
	// index gives none) and a recorded skill's YYYYMMDD; "" for a local skill.
	Version string
	// LastUpdated is when a plugin was last installed or updated, and a recorded
	// skill's commit time.
	LastUpdated time.Time
	// Enabled: a plugin Claude Code has enabled, a skill in ~/.claude/skills.
	Enabled bool
	// Local is a skill directory Code Foundry did not install: only removing it is
	// offered.
	Local bool
	// Missing is a recorded skill whose directory is in neither place.
	Missing bool
	// Dir is where it is on disk: the skill's directory, a plugin's install path.
	Dir string
	// Scope is a plugin's Claude Code scope (user, project, local).
	Scope string
	// Skills are a plugin's skill names, from its index entry.
	Skills []string
	// SetupScript is a recorded skill's setup script, relative to Dir.
	SetupScript string
	// NeedsSetup: a setup script that never exited 0, or that changed since it did.
	NeedsSetup bool
	// Update is the registry's newer version, nil when there is none.
	Update *Offer
}

// ID is a plugin's name@marketplace and a skill's name.
func (i Installed) ID() string {
	if i.Kind == marketplace.KindPlugin && i.Registry != "" {
		return PluginID(i.Name, i.Registry)
	}
	return i.Name
}

// InstalledOf is what is installed of a marketplace entry: the plugin of its name from
// its marketplace, the skill installed from its marketplace and path (whatever its
// directory is called now). ok is false when nothing is.
func (snap *Snapshot) InstalledOf(e marketplace.Entry) (Installed, bool) {
	for _, in := range snap.Installed {
		if in.Kind != e.Kind || in.Registry != e.Registry || e.Registry == "" {
			continue
		}
		if e.Kind == marketplace.KindPlugin && in.Name == e.Name || e.Kind == marketplace.KindSkill && in.Path == e.Path {
			return in, true
		}
	}
	return Installed{}, false
}

// Offer is a newer version in the registry.
type Offer struct {
	Version     string
	LastUpdated time.Time
	CommitSHA   string
}

// syncedDir is the ~/.claude/skills subdirectory Claude Code keeps synced skills in;
// never listed.
const syncedDir = "synced"

// installedPlugins joins `claude plugin list` with the catalogs: description, skills,
// tier and an update offer (pluginOffer).
func installedPlugins(plugins []pluginInfo, cats map[string]*marketplace.Catalog) []Installed {
	var out []Installed
	for _, p := range plugins {
		name, reg := splitPluginID(p.ID)
		in := Installed{
			Kind: marketplace.KindPlugin, Name: name, Registry: reg, Version: p.Version, Enabled: p.Enabled,
			Dir: p.InstallPath, Scope: p.Scope, LastUpdated: parseTime(cmp.Or(p.LastUpdated, p.InstalledAt)),
		}
		if e, ok := catalogEntry(cats[reg], marketplace.KindPlugin, func(e marketplace.Entry) bool { return e.Name == name }); ok {
			in.Path, in.Tier, in.Description, in.Skills, in.By = e.Path, e.Tier, e.Description, e.Skills, e.By
			in.Update = pluginOffer(e, p)
		}
		out = append(out, in)
	}
	return out
}

// pluginOffer is the update a plugin's marketplace entry offers over what is installed,
// nil for none. Claude Code installs and reports the version in the plugin's
// .claude-plugin/plugin.json, not the index's, and an index may say otherwise (1.4.0 in
// marketplace.json, 1.3.9 in plugin.json), which would offer an update `claude plugin
// update` never brings. So when the checkout has a plugin.json with a version the offer
// compares like with like: that version against the installed copy's plugin.json (else
// what `plugin list` reported). Only a checkout without one falls back to the index.
func pluginOffer(e marketplace.Entry, p pluginInfo) *Offer {
	avail, have := e.Version, p.Version
	if e.ManifestVersion != "" {
		avail = e.ManifestVersion
		have = cmp.Or(marketplace.ManifestVersion(p.InstallPath), p.Version)
	}
	if !update.Newer(avail, have) {
		return nil
	}
	return &Offer{Version: avail, LastUpdated: e.LastUpdated, CommitSHA: e.CommitSHA}
}

// installedSkills lists the skill directories in skillsDir (enabled) and disabledDir,
// joined with the records, and the records whose directory is gone. A recorded skill's
// update offer is its registry entry (by path) with a newer commit time.
func installedSkills(skillsDir, disabledDir string, recs map[string]Record, cats map[string]*marketplace.Catalog) []Installed {
	byName := map[string]*Installed{}
	var order []string
	add := func(dir string, enabled bool) {
		for _, name := range skillDirs(dir) {
			if prev, ok := byName[name]; ok {
				if !prev.Enabled && enabled {
					prev.Enabled, prev.Dir = true, filepath.Join(dir, name)
				}
				continue
			}
			in := &Installed{Kind: marketplace.KindSkill, Name: name, Enabled: enabled, Dir: filepath.Join(dir, name)}
			fm := readFrontmatter(in.Dir)
			in.Description, in.By = strings.Join(strings.Fields(fm.Description), " "), fm.By()
			byName[name] = in
			order = append(order, name)
		}
	}
	add(skillsDir, true)
	add(disabledDir, false)
	for name := range recs {
		if _, ok := byName[name]; !ok {
			byName[name] = &Installed{Kind: marketplace.KindSkill, Name: name, Missing: true}
			order = append(order, name)
		}
	}
	out := make([]Installed, 0, len(order))
	for _, name := range order {
		in := byName[name]
		r, ok := recs[name]
		if !ok {
			in.Local = true
			out = append(out, *in)
			continue
		}
		in.Registry, in.Path, in.Tier, in.LastUpdated, in.SetupScript = r.Registry, r.Path, r.Tier, r.CommitAt, r.SetupScript
		if !r.CommitAt.IsZero() {
			in.Version = r.CommitAt.UTC().Format("20060102")
		}
		if r.SetupScript != "" && !in.Missing {
			in.NeedsSetup = r.SetupDoneAt.IsZero() || fileSHA256(filepath.Join(in.Dir, filepath.FromSlash(r.SetupScript))) != r.SetupSHA256
		}
		if e, ok := catalogEntry(cats[r.Registry], marketplace.KindSkill, func(e marketplace.Entry) bool { return e.Path == r.Path }); ok {
			if in.Description == "" {
				in.Description = e.Description
			}
			in.By = cmp.Or(e.By, in.By)
			if e.LastUpdated.After(r.CommitAt) {
				in.Update = &Offer{Version: e.Version, LastUpdated: e.LastUpdated, CommitSHA: e.CommitSHA}
			}
		}
		out = append(out, *in)
	}
	return out
}

// skillDirs are dir's top-level skill directories: those with a SKILL.md, not hidden,
// not synced. A directory that is a symlink counts.
func skillDirs(dir string) []string {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range ents {
		n := e.Name()
		if strings.HasPrefix(n, ".") || n == syncedDir {
			continue
		}
		if fi, err := os.Stat(filepath.Join(dir, n, marketplace.SkillFile)); err == nil && fi.Mode().IsRegular() {
			out = append(out, n)
		}
	}
	return out
}

// readFrontmatter is the frontmatter of dir's SKILL.md; the zero value when it cannot
// be read.
func readFrontmatter(dir string) marketplace.Frontmatter {
	f, err := os.Open(filepath.Join(dir, marketplace.SkillFile))
	if err != nil {
		return marketplace.Frontmatter{}
	}
	defer func() { _ = f.Close() }()
	head, err := io.ReadAll(io.LimitReader(f, 64<<10))
	if err != nil {
		return marketplace.Frontmatter{}
	}
	return marketplace.ParseFrontmatter(string(head))
}

// fileSHA256 is the hex SHA-256 of the file at p; "" when it cannot be read.
func fileSHA256(p string) string {
	f, err := os.Open(p)
	if err != nil {
		return ""
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return ""
	}
	return hex.EncodeToString(h.Sum(nil))
}

func catalogEntry(c *marketplace.Catalog, kind marketplace.Kind, match func(marketplace.Entry) bool) (marketplace.Entry, bool) {
	if c == nil {
		return marketplace.Entry{}, false
	}
	i := slices.IndexFunc(c.Entries, func(e marketplace.Entry) bool { return e.Kind == kind && match(e) })
	if i < 0 {
		return marketplace.Entry{}, false
	}
	return c.Entries[i], true
}

// sortInstalled orders by name (case-insensitive), then kind and registry.
func sortInstalled(l []Installed) {
	slices.SortFunc(l, func(a, b Installed) int {
		return cmp.Or(
			cmp.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)),
			cmp.Compare(a.Kind, b.Kind),
			cmp.Compare(a.Registry, b.Registry),
		)
	})
}

func parseTime(s string) time.Time {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return time.Time{}
	}
	return t
}
