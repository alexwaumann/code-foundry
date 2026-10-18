package registry

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"slices"
	"strings"
)

// Location is where a registry's index.json is read from.
type Location struct {
	// URL is the registry as configured, normalized (no trailing slash or .git).
	URL string
	// Repo is "owner/name" for a registry on github.com (read with gh); else "".
	Repo string
	// IndexURL is the index's HTTPS URL for any other registry; else "".
	IndexURL string
}

// ParseLocation reads one plugins.registries entry: https://github.com/<owner>/<repo>
// (or the owner/repo shorthand) for a registry repository on GitHub, read with gh; any
// other https URL is the index itself (".../index.json"; a URL not ending in .json gets
// /index.json appended). Plain http is accepted for loopback hosts only (a local test
// registry): an index names the hashes the downloads are checked against, so it must not
// be open to tampering on the way.
func ParseLocation(raw string) (Location, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return Location{}, errors.New("empty registry URL")
	}
	if repoPattern.MatchString(s) && !strings.Contains(s, ":") {
		s = "https://github.com/" + s
	}
	u, err := url.Parse(s)
	if err != nil {
		return Location{}, fmt.Errorf("registry %q: %w", raw, err)
	}
	if err := checkScheme(u); err != nil {
		return Location{}, fmt.Errorf("registry %q: %w", raw, err)
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return Location{}, fmt.Errorf("registry %q: no credentials, query or fragment", raw)
	}
	if strings.EqualFold(u.Host, "github.com") || strings.EqualFold(u.Host, "www.github.com") {
		parts := strings.Split(strings.Trim(u.Path, "/"), "/")
		if len(parts) != 2 || u.Scheme != "https" {
			return Location{}, fmt.Errorf("registry %q: want https://github.com/<owner>/<repo>", raw)
		}
		repo := parts[0] + "/" + strings.TrimSuffix(parts[1], ".git")
		if !repoPattern.MatchString(repo) {
			return Location{}, fmt.Errorf("registry %q: %q is not owner/repo", raw, repo)
		}
		return Location{URL: "https://github.com/" + repo, Repo: repo}, nil
	}
	if strings.EqualFold(u.Host, "raw.githubusercontent.com") && u.Scheme == "https" {
		// Fine as a plain URL (a public repository's raw file).
		return Location{URL: u.String(), IndexURL: u.String()}, nil
	}
	norm := strings.TrimRight(u.String(), "/")
	idx := norm
	if !strings.HasSuffix(strings.ToLower(u.Path), ".json") {
		idx = norm + "/" + IndexFile
	}
	return Location{URL: norm, IndexURL: idx}, nil
}

// ParseList reads the plugins.registries setting: URLs separated by commas, spaces or
// newlines, in priority order (the first registry listing a name wins). "none" is the
// empty list. Duplicates are dropped.
func ParseList(s string) ([]Location, error) {
	if strings.EqualFold(strings.TrimSpace(s), "none") {
		return nil, nil
	}
	fields := strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ' ' || r == '\n' || r == '\t' || r == '\r' })
	var out []Location
	var errs []error
	for _, f := range fields {
		loc, err := ParseLocation(f)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		if !slices.ContainsFunc(out, func(l Location) bool { return l.URL == loc.URL }) {
			out = append(out, loc)
		}
	}
	return out, errors.Join(errs...)
}

// checkScheme allows https anywhere and http on loopback hosts only.
func checkScheme(u *url.URL) error {
	switch u.Scheme {
	case "https":
		if u.Host == "" {
			return errors.New("no host")
		}
		return nil
	case "http":
		if isLoopback(u.Hostname()) {
			return nil
		}
		return errors.New("plain http only for localhost; use https")
	}
	return fmt.Errorf("scheme %q: want https", u.Scheme)
}

func isLoopback(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// checkDownloadURL validates an artifact URL (https, or http on loopback).
func checkDownloadURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	if err := checkScheme(u); err != nil {
		return nil, err
	}
	return u, nil
}

// ReleaseAsset is a GitHub release download URL taken apart.
type ReleaseAsset struct {
	Repo, Tag, Name string
}

// ParseReleaseURL recognizes https://github.com/<owner>/<repo>/releases/download/<tag>/<asset>,
// which is downloaded with `gh release download` (private repositories work). A tag or
// asset name starting with "-" is not one (it would reach gh as a flag).
func ParseReleaseURL(raw string) (ReleaseAsset, bool) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || !strings.EqualFold(u.Host, "github.com") {
		return ReleaseAsset{}, false
	}
	parts := strings.Split(strings.TrimPrefix(u.Path, "/"), "/")
	if len(parts) != 6 || parts[2] != "releases" || parts[3] != "download" || parts[4] == "" || parts[5] == "" {
		return ReleaseAsset{}, false
	}
	repo := parts[0] + "/" + parts[1]
	if !repoPattern.MatchString(repo) {
		return ReleaseAsset{}, false
	}
	tag, err1 := url.PathUnescape(parts[4])
	name, err2 := url.PathUnescape(parts[5])
	if err1 != nil || err2 != nil || strings.HasPrefix(tag, "-") || strings.HasPrefix(name, "-") {
		// gh would read a leading "-" as a flag (`gh release download --dir=… -R …`).
		return ReleaseAsset{}, false
	}
	return ReleaseAsset{Repo: repo, Tag: tag, Name: name}, true
}
