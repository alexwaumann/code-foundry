// Package registry reads plugin registries and fetches what they point at
// (docs/notes/plugins-7-registry.md; the format is the registry repository's README,
// github.com/alexwaumann/code-foundry-plugins). A registry serves index.json:
//
//	{ "schema": 1, "generatedAt": "<RFC 3339>", "plugins": [ <entry>, … ] }
//
// where an entry is a plugin's name, display name, description, source repository,
// latest version, protocol, permissions (equal to its manifest's) and one release
// tarball per platform ("darwin/arm64": {url, sha256}). Clients tolerate unknown fields;
// an entry that does not parse or validate is skipped with an issue, never the whole
// index.
//
// The Client reads every registry of the plugins.registries setting, caches each index
// on disk for a TTL (1 h), and merges them by name (the first registry listing a name
// wins). A registry on github.com is read with the user's gh (`gh api
// repos/<owner>/<repo>/contents/index.json`), so a private registry needs no other auth;
// any other registry is an HTTPS URL of an index.json. Release tarballs on github.com
// are downloaded with `gh release download` for the same reason.
//
// This package knows nothing about installed plugins: the plugin store (install.go,
// updates.go) uses it.
package registry

import (
	"encoding/json"
	"fmt"
	"regexp"
	"runtime"
	"slices"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/store/update"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// IndexFile is the registry's index file name.
const IndexFile = "index.json"

// SchemaVersion is the index schema this client reads. A higher one is read as far as
// it goes (unknown fields are ignored), with an issue.
const SchemaVersion = 1

// Index is one registry's index.json.
type Index struct {
	Schema      int     `json:"schema"`
	GeneratedAt string  `json:"generatedAt,omitempty"`
	Plugins     []Entry `json:"plugins"`
}

// Entry is one plugin of a registry: its latest version and where to get it.
type Entry struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName,omitempty"`
	Description string `json:"description,omitempty"`
	// Repo is the plugin's source repository, "owner/name" on github.com.
	Repo string `json:"repo,omitempty"`
	// Version is the latest version: strict semver, no leading v. The release tag is
	// "v" + Version.
	Version  string `json:"version"`
	Protocol int    `json:"protocol"`
	// Permissions equal the manifest's (the registry's CI checks it), so Browse shows
	// what a plugin will ask for before anything is downloaded.
	Permissions pluginsdk.Permissions `json:"permissions"`
	// Artifacts by platform ("darwin/arm64", "darwin/amd64").
	Artifacts map[string]Artifact `json:"artifacts"`

	// Registry is the URL of the registry the entry came from (set by the Client; not in
	// the file).
	Registry string `json:"-"`
}

// Artifact is one platform's release tarball.
type Artifact struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
}

// DisplayNameOr is the display name, else the name.
func (e Entry) DisplayNameOr() string {
	if e.DisplayName != "" {
		return e.DisplayName
	}
	return e.Name
}

// Artifact returns the entry's tarball for platform ("darwin/arm64").
func (e Entry) Artifact(platform string) (Artifact, bool) {
	a, ok := e.Artifacts[platform]
	return a, ok
}

// Platform is this build's platform key: "darwin/arm64" or "darwin/amd64".
func Platform() string { return runtime.GOOS + "/" + runtime.GOARCH }

var (
	// namePattern is the registry's NAME_RE (the manifest's name rule).
	namePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
	sha256Hex   = regexp.MustCompile(`^[0-9a-f]{64}$`)
	repoPattern = regexp.MustCompile(`^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$`)
	// platformPattern is "<os>/<arch>".
	platformPattern = regexp.MustCompile(`^[a-z0-9]+/[a-z0-9]+$`)
)

// ValidName reports whether name is a plugin name.
func ValidName(name string) bool { return namePattern.MatchString(name) }

// ValidVersion reports whether v is a strict semantic version without a leading v.
func ValidVersion(v string) bool {
	return v != "" && !strings.HasPrefix(v, "v") && update.IsSemver(v)
}

// Newer reports whether candidate is a strictly newer version than current (semver
// precedence; either one malformed is never newer).
func Newer(candidate, current string) bool { return update.Newer(candidate, current) }

// Parse decodes index.json leniently: unknown fields are ignored, and an entry that does
// not decode or validate is left out with an issue. Only an index that is not a JSON
// object with a plugins list is an error.
func Parse(data []byte) (Index, []string, error) {
	var raw struct {
		Schema      int               `json:"schema"`
		GeneratedAt string            `json:"generatedAt"`
		Plugins     []json.RawMessage `json:"plugins"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return Index{}, nil, fmt.Errorf("%s: %w", IndexFile, err)
	}
	if raw.Plugins == nil {
		var probe map[string]json.RawMessage
		if json.Unmarshal(data, &probe) != nil || probe["plugins"] == nil {
			return Index{}, nil, fmt.Errorf("%s: no plugins list", IndexFile)
		}
	}
	idx := Index{Schema: raw.Schema, GeneratedAt: raw.GeneratedAt, Plugins: []Entry{}}
	var issues []string
	if raw.Schema > SchemaVersion {
		issues = append(issues, fmt.Sprintf("schema %d is newer than this Code Foundry reads (%d): read what it understands", raw.Schema, SchemaVersion))
	}
	seen := map[string]bool{}
	for i, msg := range raw.Plugins {
		var e Entry
		if err := json.Unmarshal(msg, &e); err != nil {
			issues = append(issues, fmt.Sprintf("plugins[%d]: %v", i, err))
			continue
		}
		if err := e.Validate(); err != nil {
			issues = append(issues, fmt.Sprintf("plugins[%d] (%s): %v", i, e.Name, err))
			continue
		}
		if seen[e.Name] {
			issues = append(issues, fmt.Sprintf("plugins[%d]: %s is listed twice; the first one counts", i, e.Name))
			continue
		}
		seen[e.Name] = true
		e.Permissions = e.Permissions.Normalize()
		idx.Plugins = append(idx.Plugins, e)
	}
	slices.SortFunc(idx.Plugins, func(a, b Entry) int { return strings.Compare(a.Name, b.Name) })
	return idx, issues, nil
}

// Validate checks what a client relies on: the name, the version, the repository's
// shape, and every artifact's platform, URL and hash. The rest (display name,
// description, protocol) is shown as is; the install checks the protocol.
func (e Entry) Validate() error {
	switch {
	case !ValidName(e.Name):
		return fmt.Errorf("name %q must match %s", e.Name, namePattern)
	case !ValidVersion(e.Version):
		return fmt.Errorf("version %q is not a semantic version (1.2.3, no leading v)", e.Version)
	case e.Repo != "" && !repoPattern.MatchString(e.Repo):
		return fmt.Errorf("repo %q is not owner/name", e.Repo)
	case len(e.Artifacts) == 0:
		return fmt.Errorf("no artifacts")
	}
	for plat, a := range e.Artifacts {
		if !platformPattern.MatchString(plat) {
			return fmt.Errorf("artifacts: %q is not <os>/<arch>", plat)
		}
		if _, err := checkDownloadURL(a.URL); err != nil {
			return fmt.Errorf("artifacts[%s].url: %w", plat, err)
		}
		if !sha256Hex.MatchString(strings.ToLower(a.SHA256)) {
			return fmt.Errorf("artifacts[%s].sha256: want 64 hex digits", plat)
		}
	}
	return nil
}

// TarballName is a release tarball's name by the registry's convention:
// <name>-<version>-<os>-<arch>.tar.gz.
func TarballName(name, version, platform string) string {
	return name + "-" + version + "-" + strings.ReplaceAll(platform, "/", "-") + ".tar.gz"
}
