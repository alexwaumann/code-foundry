// Package marketplace reads a Claude Code marketplace checkout (a git clone Claude Code
// keeps under ~/.claude/plugins/marketplaces) into the entries Settings → Skills →
// Browse shows: the plugins its .claude-plugin/marketplace.json lists and the standalone
// skills under <tier>/skills/**. It only reads files and git history; it never touches
// the network (docs/notes/skills-1-registry.md).
package marketplace

import (
	"cmp"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// Kind is what an entry installs as.
type Kind string

// Kinds.
const (
	// KindPlugin is a Claude Code plugin the marketplace index lists; Claude Code
	// installs it.
	KindPlugin Kind = "plugin"
	// KindSkill is a standalone skill directory; Code Foundry copies it into
	// ~/.claude/skills.
	KindSkill Kind = "skill"
)

// Tier is the top-level folder an entry lives under.
type Tier string

// Tiers. An entry outside both (a plugin at ./plugins/x in a public marketplace) has
// tier "".
const (
	TierEnterprise Tier = "enterprise"
	TierCommunity  Tier = "community"
)

// Tiers are the tiers in display order; standalone skills are read from
// <tier>/skills/** for each.
var Tiers = []Tier{TierEnterprise, TierCommunity}

// ParseTier is s as a Tier ("" for anything else).
func ParseTier(s string) Tier {
	if t := Tier(strings.ToLower(s)); slices.Contains(Tiers, t) {
		return t
	}
	return ""
}

// Entry is one plugin or skill a marketplace offers.
type Entry struct {
	Kind        Kind
	Tier        Tier
	Name        string
	Description string
	// By is a plugin's plugin.json author.name (else the index entry's author), a
	// skill's frontmatter owner / metadata.owner / metadata.author / author.
	By string
	// Version is a plugin's index version (else its plugin.json's); a skill's is
	// YYYYMMDD (UTC) of the last commit touching its directory, "" without git.
	Version string
	// ManifestVersion is a plugin's .claude-plugin/plugin.json version in the checkout:
	// what Claude Code installs and reports (`claude plugin list`), so the one an update
	// offer compares. "" when the plugin has no plugin.json here (or it has no version).
	ManifestVersion string
	// DeclaredVersion is a skill's frontmatter metadata.version, for display only.
	DeclaredVersion string
	// LastUpdated and CommitSHA are the last commit touching Path; zero without git.
	LastUpdated time.Time
	CommitSHA   string
	// Registry is the marketplace's name (as `claude plugin marketplace list` has it).
	Registry string
	// Path is the repo-relative, slash-separated directory ("" for a plugin whose
	// source is outside the checkout: a git URL or another repository).
	Path     string
	Keywords []string
	// Skills are a plugin's skill names, sorted.
	Skills []string
	// SetupScript is a skill's setup script, repo-relative: the first of install.sh,
	// setup.sh, scripts/install.sh, scripts/setup.sh in its directory; "" for none.
	SetupScript string
}

// SetupScriptInSkill is SetupScript relative to the skill's directory (what an
// installed copy runs).
func (e Entry) SetupScriptInSkill() string {
	if e.SetupScript == "" {
		return ""
	}
	return strings.TrimPrefix(e.SetupScript, e.Path+"/")
}

// Catalog is one marketplace checkout, read.
type Catalog struct {
	// Name and Owner are marketplace.json's name and owner.name.
	Name, Owner string
	// Entries are sorted by name (case-insensitive), then tier, kind and path.
	Entries []Entry
	// Head is the checkout's HEAD commit; "" without git.
	Head    string
	Shallow bool
	// Issues are what was skipped or could not be read, one sentence each.
	Issues []string
}

// Count is how many entries of kind the catalog has.
func (c *Catalog) Count(kind Kind) int {
	n := 0
	for _, e := range c.Entries {
		if e.Kind == kind {
			n++
		}
	}
	return n
}

// IndexFile is the marketplace index, relative to the checkout.
const IndexFile = ".claude-plugin/marketplace.json"

// pluginManifest is a plugin's manifest, relative to its directory.
const pluginManifest = ".claude-plugin/plugin.json"

// ManifestVersion is the version in dir's .claude-plugin/plugin.json: a plugin
// directory in a checkout, or an installed plugin's install path. "" when there is no
// such file, it is not valid JSON, or it has no version.
func ManifestVersion(dir string) string {
	if dir == "" {
		return ""
	}
	data, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(pluginManifest)))
	if err != nil {
		return ""
	}
	var pf pluginFile
	if json.Unmarshal(data, &pf) != nil {
		return ""
	}
	return strings.TrimSpace(pf.Version)
}

// SkillFile marks a skill directory.
const SkillFile = "SKILL.md"

// maxSkillHead is how much of a SKILL.md is read for its frontmatter.
const maxSkillHead = 64 << 10

// maxDescription bounds a description, in bytes.
const maxDescription = 2000

// setupScripts are the setup script names looked for in a skill directory, in order.
var setupScripts = []string{"install.sh", "setup.sh", "scripts/install.sh", "scripts/setup.sh"}

// Read reads the checkout at dir as registry (the marketplace's name). hist dates the
// entries; nil leaves them undated. Only a missing or unreadable dir fails: a missing
// or broken index, an unreadable plugin or skill is an issue and the rest is read.
func Read(dir, registry string, hist *History) (*Catalog, error) {
	fi, err := os.Stat(dir)
	if err != nil {
		return nil, fmt.Errorf("marketplace %s: %w", registry, err)
	}
	if !fi.IsDir() {
		return nil, fmt.Errorf("marketplace %s: %s is not a directory", registry, dir)
	}
	r := reader{root: dir, registry: registry, hist: hist, cat: &Catalog{Name: registry}}
	if hist != nil {
		r.cat.Head, r.cat.Shallow = hist.Head, hist.Shallow
	}
	r.readIndex()
	for _, t := range Tiers {
		r.walkSkills(path.Join(string(t), "skills"), func(rel string) {
			if e, ok := r.skill(rel); ok {
				r.cat.Entries = append(r.cat.Entries, e)
			}
		})
	}
	slices.SortFunc(r.cat.Entries, compareEntries)
	return r.cat, nil
}

func compareEntries(a, b Entry) int {
	return cmp.Or(
		cmp.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)),
		cmp.Compare(tierRank(a.Tier), tierRank(b.Tier)),
		cmp.Compare(a.Kind, b.Kind),
		cmp.Compare(a.Path, b.Path),
	)
}

func tierRank(t Tier) int {
	if i := slices.Index(Tiers, t); i >= 0 {
		return i
	}
	return len(Tiers)
}

type reader struct {
	root, registry string
	hist           *History
	cat            *Catalog
}

func (r *reader) issue(format string, args ...any) {
	r.cat.Issues = append(r.cat.Issues, fmt.Sprintf(format, args...))
}

// indexFile is marketplace.json, the fields read.
type indexFile struct {
	Name  string `json:"name"`
	Owner struct {
		Name string `json:"name"`
	} `json:"owner"`
	Plugins []indexPlugin `json:"plugins"`
}

type indexPlugin struct {
	Name        string          `json:"name"`
	Source      json.RawMessage `json:"source"`
	Description string          `json:"description"`
	Version     string          `json:"version"`
	Category    string          `json:"category"`
	Tags        []string        `json:"tags"`
	Keywords    []string        `json:"keywords"`
	Author      json.RawMessage `json:"author"`
	Skills      json.RawMessage `json:"skills"`
}

type pluginFile struct {
	Name        string          `json:"name"`
	Version     string          `json:"version"`
	Description string          `json:"description"`
	Author      json.RawMessage `json:"author"`
	Keywords    []string        `json:"keywords"`
	Skills      json.RawMessage `json:"skills"`
}

func (r *reader) readIndex() {
	data, err := os.ReadFile(filepath.Join(r.root, filepath.FromSlash(IndexFile)))
	if err != nil {
		if !os.IsNotExist(err) {
			r.issue("%s cannot be read: %v", IndexFile, err)
		} else {
			r.issue("%s is missing, so no plugins are listed", IndexFile)
		}
		return
	}
	var idx indexFile
	if err := json.Unmarshal(data, &idx); err != nil {
		r.issue("%s is not valid: %v", IndexFile, err)
		return
	}
	r.cat.Name = cmp.Or(idx.Name, r.registry)
	r.cat.Owner = idx.Owner.Name
	seen := map[string]bool{}
	for i, p := range idx.Plugins {
		if p.Name == "" {
			r.issue("plugin %d in %s has no name and was skipped", i+1, IndexFile)
			continue
		}
		if seen[p.Name] {
			r.issue("plugin %s is listed twice in %s; the first wins", p.Name, IndexFile)
			continue
		}
		seen[p.Name] = true
		r.cat.Entries = append(r.cat.Entries, r.plugin(p))
	}
}

// plugin reads an index entry, with its plugin.json and skills when its source is a
// directory in the checkout.
func (r *reader) plugin(p indexPlugin) Entry {
	e := Entry{
		Kind: KindPlugin, Name: p.Name, Description: clip(p.Description), Version: p.Version,
		Registry: r.registry, By: authorName(p.Author),
		Keywords: keywords(append(append(slices.Clone(p.Tags), p.Category), p.Keywords...)),
	}
	var src string
	if json.Unmarshal(p.Source, &src) != nil || src == "" {
		return e // a git URL, another repository: nothing to read here
	}
	rel, ok := r.rel(src)
	if !ok {
		r.issue("plugin %s: source %q is outside the marketplace and was not read", p.Name, src)
		return e
	}
	e.Path = rel
	e.Tier = tierOf(rel)
	r.date(&e)
	var pf pluginFile
	if data, err := os.ReadFile(filepath.Join(r.abs(rel), filepath.FromSlash(pluginManifest))); err == nil {
		if err := json.Unmarshal(data, &pf); err != nil {
			r.issue("plugin %s: %s is not valid: %v", p.Name, pluginManifest, err)
		}
	} else if !os.IsNotExist(err) {
		r.issue("plugin %s: %s cannot be read: %v", p.Name, pluginManifest, err)
	}
	e.By = cmp.Or(authorName(pf.Author), e.By)
	e.Version = cmp.Or(e.Version, pf.Version)
	e.ManifestVersion = strings.TrimSpace(pf.Version)
	e.Description = cmp.Or(e.Description, clip(pf.Description))
	e.Keywords = keywords(append(e.Keywords, pf.Keywords...))
	// The skills: the index entry's list, else plugin.json's, else <source>/skills/**.
	// A listed path is a skill directory or a directory of them.
	dirs := stringList(p.Skills)
	if dirs == nil {
		dirs = stringList(pf.Skills)
	}
	if dirs == nil {
		dirs = []string{"skills"}
	}
	names := map[string]bool{}
	for _, d := range dirs {
		sub, ok := r.rel(path.Join(rel, strings.TrimPrefix(d, "./")))
		if !ok || !strings.HasPrefix(sub+"/", rel+"/") && rel != "." {
			r.issue("plugin %s: skills path %q is outside the plugin and was not read", p.Name, d)
			continue
		}
		r.walkSkills(sub, func(skillRel string) {
			fm, _ := r.frontmatter(skillRel)
			names[cmp.Or(fm.Name, path.Base(skillRel))] = true
		})
	}
	e.Skills = slices.Sorted(func(yield func(string) bool) {
		for n := range names {
			if !yield(n) {
				return
			}
		}
	})
	return e
}

// skill reads the skill directory rel.
func (r *reader) skill(rel string) (Entry, bool) {
	fm, err := r.frontmatter(rel)
	if err != nil {
		r.issue("skill %s cannot be read: %v", rel, err)
		return Entry{}, false
	}
	e := Entry{
		Kind: KindSkill, Tier: tierOf(rel), Name: cmp.Or(fm.Name, path.Base(rel)),
		Description: clip(fm.Description), By: fm.By(), DeclaredVersion: fm.MetaVersion,
		Registry: r.registry, Path: rel, Keywords: keywords(fm.Keywords),
	}
	r.date(&e)
	if !e.LastUpdated.IsZero() {
		e.Version = e.LastUpdated.UTC().Format("20060102")
	}
	for _, s := range setupScripts {
		if fi, err := os.Lstat(filepath.Join(r.abs(rel), filepath.FromSlash(s))); err == nil && fi.Mode().IsRegular() {
			e.SetupScript = rel + "/" + s
			break
		}
	}
	return e, true
}

func (r *reader) date(e *Entry) {
	if c, ok := r.hist.Dir(e.Path); ok {
		e.LastUpdated, e.CommitSHA = c.At, c.SHA
	}
}

func (r *reader) frontmatter(rel string) (Frontmatter, error) {
	f, err := os.Open(filepath.Join(r.abs(rel), SkillFile))
	if err != nil {
		return Frontmatter{}, err
	}
	defer func() { _ = f.Close() }()
	head, err := io.ReadAll(io.LimitReader(f, maxSkillHead))
	if err != nil {
		return Frontmatter{}, err
	}
	return ParseFrontmatter(string(head)), nil
}

// walkSkills calls fn with every skill directory at or under rel (repo-relative): each
// directory holding a SKILL.md, without looking for more inside it. Symlinks and
// hidden directories are not followed. A missing rel is nothing.
func (r *reader) walkSkills(rel string, fn func(rel string)) {
	start := r.abs(rel)
	_ = filepath.WalkDir(start, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if p != start || !os.IsNotExist(err) {
				r.issue("%s cannot be read: %v", r.relOf(p), err)
			}
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if !d.IsDir() {
			return nil
		}
		if p != start && strings.HasPrefix(d.Name(), ".") {
			return fs.SkipDir
		}
		if fi, err := os.Lstat(filepath.Join(p, SkillFile)); err == nil && fi.Mode().IsRegular() {
			fn(r.relOf(p))
			return fs.SkipDir
		}
		return nil
	})
}

func (r *reader) abs(rel string) string { return filepath.Join(r.root, filepath.FromSlash(rel)) }

func (r *reader) relOf(p string) string {
	rel, err := filepath.Rel(r.root, p)
	if err != nil {
		return p
	}
	return filepath.ToSlash(rel)
}

// rel cleans a repo-relative source ("./a/b") and reports whether it stays inside the
// checkout.
func (r *reader) rel(src string) (string, bool) {
	if path.IsAbs(src) || filepath.IsAbs(src) {
		return "", false
	}
	c := cleanRel(src)
	if c == ".." || strings.HasPrefix(c, "../") {
		return "", false
	}
	return c, true
}

// tierOf is the tier a repo-relative path's first segment names.
func tierOf(rel string) Tier {
	first, _, _ := strings.Cut(rel, "/")
	return ParseTier(first)
}

// authorName reads an author given as {"name": …} or a plain string.
func authorName(raw json.RawMessage) string {
	var a struct {
		Name string `json:"name"`
	}
	if json.Unmarshal(raw, &a) == nil && a.Name != "" {
		return a.Name
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	return ""
}

// stringList reads a JSON string or list of strings; nil when raw is neither.
func stringList(raw json.RawMessage) []string {
	var l []string
	if json.Unmarshal(raw, &l) == nil && l != nil {
		return l
	}
	var s string
	if json.Unmarshal(raw, &s) == nil && s != "" {
		return []string{s}
	}
	return nil
}

// keywords trims, drops empties and duplicates (case-insensitive), keeping order.
func keywords(in []string) []string {
	var out []string
	seen := map[string]bool{}
	for _, k := range in {
		k = strings.TrimSpace(k)
		if k == "" || seen[strings.ToLower(k)] {
			continue
		}
		seen[strings.ToLower(k)] = true
		out = append(out, k)
	}
	return out
}

// clip collapses whitespace and bounds s to maxDescription bytes (on a rune boundary).
func clip(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) <= maxDescription {
		return s
	}
	cut := maxDescription
	for cut > 0 && !utf8RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + "…"
}

func utf8RuneStart(b byte) bool { return b&0xC0 != 0x80 }
