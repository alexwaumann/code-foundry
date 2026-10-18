package registry

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Release is a plugin release on GitHub, found by the tarball naming convention, for a
// direct install (`plugin install <owner>/<repo>[@vX.Y.Z]`).
type Release struct {
	Repo, Tag string
	// Name and Version come from the tarball's name: <name>-<version>-<os>-<arch>.tar.gz.
	Name, Version string
	// Asset is this platform's tarball; SHA256 is from the release's checksums file, ""
	// when it has none.
	Asset Artifact
	// AssetName is the tarball's file name; Checksums the checksums file's ("" = none).
	AssetName, Checksums string
}

// ChecksumFiles are the asset names a release's checksums may be in, tried in order
// (plus <tarball>.sha256). Lines are `<sha256>  <file>` (sha256sum, shasum -a 256 and
// pluginpack write them).
var ChecksumFiles = []string{"checksums.txt", "SHA256SUMS", "sha256sums.txt"}

// ParseRepoRef reads "<owner>/<repo>[@<tag>]".
func ParseRepoRef(ref string) (repo, tag string, ok bool) {
	repo, tag, _ = strings.Cut(ref, "@")
	return repo, tag, repoPattern.MatchString(repo)
}

// ResolveRelease finds the plugin tarball for platform in a release of repo: the one
// tagged tag, or the latest release when tag is empty. The tarball's name gives the
// plugin's name and version; its hash comes from a checksums asset when the release has
// one (a release without one installs unverified, and the caller warns).
func (f Fetcher) ResolveRelease(ctx context.Context, repo, tag, platform, tmpDir string) (Release, error) {
	args := []string{"release", "view"}
	if tag != "" {
		args = append(args, tag)
	}
	args = append(args, "-R", repo, "--json", "tagName,assets")
	out, err := f.Gh.Run(ctx, args...)
	if errors.Is(err, ErrNotFound) {
		what := "a release"
		if tag != "" {
			what = "release " + tag
		}
		return Release{}, fmt.Errorf("%w: %s has no %s (or no access with your gh login)", ErrNotFound, repo, what)
	}
	if err != nil {
		return Release{}, err
	}
	var rel struct {
		TagName string `json:"tagName"`
		Assets  []struct {
			Name string `json:"name"`
			URL  string `json:"url"`
		} `json:"assets"`
	}
	if err := json.Unmarshal(out, &rel); err != nil {
		return Release{}, fmt.Errorf("gh release view %s: %w", repo, err)
	}
	version := strings.TrimPrefix(rel.TagName, "v")
	if !ValidVersion(version) {
		return Release{}, fmt.Errorf("release %s of %s: the tag is not v<semver>", rel.TagName, repo)
	}
	suffix := "-" + version + "-" + strings.ReplaceAll(platform, "/", "-") + ".tar.gz"
	re := regexp.MustCompile(`^([a-z0-9][a-z0-9-]{0,63})` + regexp.QuoteMeta(suffix) + `$`)
	r := Release{Repo: repo, Tag: rel.TagName, Version: version}
	urls := map[string]string{}
	for _, a := range rel.Assets {
		urls[a.Name] = a.URL
		m := re.FindStringSubmatch(a.Name)
		if m == nil {
			continue
		}
		if r.AssetName != "" {
			return Release{}, fmt.Errorf("release %s of %s has two %s tarballs: %s and %s", rel.TagName, repo, platform, r.AssetName, a.Name)
		}
		r.Name, r.AssetName, r.Asset.URL = m[1], a.Name, a.URL
	}
	if r.AssetName == "" {
		return Release{}, fmt.Errorf("%w: release %s of %s has no <name>%s tarball", ErrNotFound, rel.TagName, repo, suffix)
	}
	if _, ok := ParseReleaseURL(r.Asset.URL); !ok {
		// gh gives the browser download URL; build it when it did not.
		r.Asset.URL = "https://github.com/" + repo + "/releases/download/" + rel.TagName + "/" + r.AssetName
	}
	for _, name := range append(ChecksumFiles, r.Name+"-"+version+"-checksums.txt", r.AssetName+".sha256") {
		u, ok := urls[name]
		if !ok {
			continue
		}
		if _, isRelease := ParseReleaseURL(u); !isRelease {
			u = "https://github.com/" + repo + "/releases/download/" + rel.TagName + "/" + name
		}
		tmp, err := tempFile(tmpDir, "checksums-*")
		if err != nil {
			return Release{}, err
		}
		err = f.Download(ctx, u, tmp, nil)
		var data []byte
		if err == nil {
			data, err = os.ReadFile(tmp)
		}
		_ = os.Remove(tmp)
		if err != nil {
			return Release{}, fmt.Errorf("checksums %s: %w", name, err)
		}
		sum, ok := FindChecksum(data, r.AssetName)
		if !ok {
			return Release{}, fmt.Errorf("checksums file %s of release %s does not list %s", name, rel.TagName, r.AssetName)
		}
		r.Asset.SHA256, r.Checksums = sum, name
		break
	}
	return r, nil
}

// FindChecksum finds file's SHA-256 in a checksums file: lines `<hex>  <file>` or
// `<hex> *<file>` (binary mode), or a lone hash (a <file>.sha256).
func FindChecksum(data []byte, file string) (string, bool) {
	sc := bufio.NewScanner(bytes.NewReader(data))
	var lone []string
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		switch {
		case len(fields) == 1 && sha256Hex.MatchString(strings.ToLower(fields[0])):
			lone = append(lone, strings.ToLower(fields[0]))
		case len(fields) == 2 && sha256Hex.MatchString(strings.ToLower(fields[0])):
			name := strings.TrimPrefix(fields[1], "*")
			if name == file || filepath.Base(name) == file {
				return strings.ToLower(fields[0]), true
			}
		}
	}
	if len(lone) == 1 {
		return lone[0], true
	}
	return "", false
}
