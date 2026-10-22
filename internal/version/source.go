package version

import (
	"reflect"
	"regexp"
	"strings"
)

// Module is the code-foundry module path, read from this package's own import path so
// it is written down nowhere else: "github.com/alexwaumann/code-foundry".
var Module = strings.TrimSuffix(reflect.TypeFor[Info]().PkgPath(), "/internal/version")

// SourceRepo is the web address of the source repository: the module path over https
// (the module is the public GitHub repository).
var SourceRepo = "https://" + Module

var (
	// tagPattern is a release tag: vX.Y.Z (stable) or vX.Y.Z-tip.N (tip).
	tagPattern = regexp.MustCompile(`^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-tip\.(0|[1-9][0-9]*))?$`)
	// shaPattern is a commit as git prints it, abbreviated or whole.
	shaPattern = regexp.MustCompile(`^[0-9a-f]{7,40}$`)
)

// Source says where the source of a build lives.
type Source struct {
	// Repo is SourceRepo.
	Repo string
	// Ref is the release tag when the version is one (vX.Y.Z or vX.Y.Z-tip.N), else the
	// commit without "-dirty", else "" (a build with neither).
	Ref string
	// URL is the tree at Ref (Repo/tree/<Ref>), or Repo when Ref is empty.
	URL string
}

// Source returns where i's source lives.
func (i Info) Source() Source {
	s := Source{Repo: SourceRepo, URL: SourceRepo}
	commit, _ := strings.CutSuffix(i.Commit, "-dirty")
	switch {
	case tagPattern.MatchString(i.Version):
		s.Ref = i.Version
	case shaPattern.MatchString(commit):
		s.Ref = commit
	}
	if s.Ref != "" {
		s.URL = SourceRepo + "/tree/" + s.Ref
	}
	return s
}

// ShortCommit is i.Commit cut to 12 characters, keeping "-dirty"; "" when unknown.
func (i Info) ShortCommit() string {
	base, dirty := strings.CutSuffix(i.Commit, "-dirty")
	if len(base) > 12 {
		base = base[:12]
	}
	if dirty {
		base += "-dirty"
	}
	return base
}

// Provenance is one line naming the build and where its source is, for files a build
// writes for agents to read (the skills):
//
//	Rendered by Code Foundry v0.21.3 (commit 844a109c1234) · source: https://github.com/alexwaumann/code-foundry/tree/v0.21.3
//
// A build that is not a release says so: its tree may not be the source it runs.
func (i Info) Provenance() string {
	s := i.Source()
	commit := i.ShortCommit()
	if commit == "" {
		commit = "unknown"
	}
	line := "Rendered by Code Foundry " + i.Version + " (commit " + commit + ") · source: " + s.URL
	switch {
	case s.Ref == "":
		line += " (dev build, commit unknown: the source there may not match this build)"
	case !tagPattern.MatchString(i.Version):
		line += " (dev build: the source there may not match this build)"
	}
	return line
}
