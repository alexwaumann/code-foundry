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
// tier and an update offer (the index version semver-newer than the installed one).
func installedPlugins(plugins []pluginInfo, cats map[string]*marketplace.Catalog) []Installed {
	var out []Installed
	for _, p := range plugins {
		name, reg := splitPluginID(p.ID)
		in := Installed{
			Kind: marketplace.KindPlugin, Name: name, Registry: reg, Version: p.Version, Enabled: p.Enabled,
			Dir: p.InstallPath, Scope: p.Scope, LastUpdated: parseTime(cmp.Or(p.LastUpdated, p.InstalledAt)),
		}
		if e, ok := catalogEntry(cats[reg], marketplace.KindPlugin, func(e marketplace.Entry) bool { return e.Name == name }); ok {
			in.Path, in.Tier, in.Description, in.Skills = e.Path, e.Tier, e.Description, e.Skills
			if update.Newer(e.Version, p.Version) {
				in.Update = &Offer{Version: e.Version, LastUpdated: e.LastUpdated, CommitSHA: e.CommitSHA}
			}
		}
		out = append(out, in)
	}
	return out
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
			in.Description = readDescription(in.Dir)
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

func readDescription(dir string) string {
	f, err := os.Open(filepath.Join(dir, marketplace.SkillFile))
	if err != nil {
		return ""
	}
	defer func() { _ = f.Close() }()
	head, err := io.ReadAll(io.LimitReader(f, 64<<10))
	if err != nil {
		return ""
	}
	return strings.Join(strings.Fields(marketplace.ParseFrontmatter(string(head)).Description), " ")
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
