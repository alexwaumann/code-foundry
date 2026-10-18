// Package pack builds a plugin's release tarball in the layout plugin registries and
// `code-foundry plugin install` expect: <name>-<version>-<os>-<arch>.tar.gz holding the
// package directory's contents at its root (plugin.json and the executable its exec
// names), plus a checksums.txt of `<sha256>  <file>` lines and, optionally, the
// registry entry (plugins/<name>.json in a registry repository). The pluginpack command
// (pluginsdk/cmd/pluginpack) is its command line. Standard library only.
package pack

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// ChecksumsFile is the checksums file written beside the tarballs.
const ChecksumsFile = "checksums.txt"

// skipped are names left out of a tarball wherever they appear.
var skipped = []string{".git", ".DS_Store"}

var platformPattern = regexp.MustCompile(`^[a-z0-9]+/[a-z0-9]+$`)

// Result is one tarball written.
type Result struct {
	// File is the tarball's path; Base its file name.
	File, Base              string
	Name, Version, Platform string
	SHA256                  string
	Size                    int64
	Manifest                pluginsdk.Manifest
}

// FileName is a tarball's name: <name>-<version>-<os>-<arch>.tar.gz.
func FileName(name, version, platform string) string {
	return name + "-" + version + "-" + strings.ReplaceAll(platform, "/", "-") + ".tar.gz"
}

// Check reads and validates dir/plugin.json and checks that the executable its exec
// names (when it is a path, not a bare command looked up on PATH) is an executable
// regular file inside dir.
func Check(dir string) (pluginsdk.Manifest, error) {
	data, err := os.ReadFile(filepath.Join(dir, pluginsdk.ManifestFile))
	if err != nil {
		return pluginsdk.Manifest{}, err
	}
	m, _, err := pluginsdk.LoadManifest(data)
	if err != nil {
		return pluginsdk.Manifest{}, fmt.Errorf("%s: %w", pluginsdk.ManifestFile, err)
	}
	if exe := m.Exec[0]; strings.Contains(exe, "/") {
		p := filepath.Join(dir, filepath.FromSlash(path.Clean(exe)))
		fi, err := os.Lstat(p)
		switch {
		case err != nil:
			return m, fmt.Errorf("exec %s: %w", exe, err)
		case !fi.Mode().IsRegular():
			return m, fmt.Errorf("exec %s is not a regular file (links are not packed)", exe)
		case fi.Mode().Perm()&0o111 == 0:
			return m, fmt.Errorf("exec %s is not executable", exe)
		}
	}
	return m, nil
}

// Tarball checks dir (Check) and writes its tarball for platform ("darwin/arm64") into
// outDir.
func Tarball(dir, outDir, platform string) (Result, error) {
	if !platformPattern.MatchString(platform) {
		return Result{}, fmt.Errorf("platform %q: want <os>/<arch>", platform)
	}
	m, err := Check(dir)
	if err != nil {
		return Result{}, err
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return Result{}, err
	}
	r := Result{Name: m.Name, Version: m.Version, Platform: platform, Manifest: m, Base: FileName(m.Name, m.Version, platform)}
	r.File = filepath.Join(outDir, r.Base)
	tmp := r.File + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return Result{}, err
	}
	h := sha256.New()
	cw := &countWriter{w: io.MultiWriter(f, h)}
	err = Write(dir, cw)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp, r.File)
	}
	if err != nil {
		_ = os.Remove(tmp)
		return Result{}, err
	}
	r.SHA256, r.Size = hex.EncodeToString(h.Sum(nil)), cw.n
	return r, nil
}

// Write writes dir's contents to w as a gzipped tar, reproducibly: sorted names, no
// owners, times at the Unix epoch, modes 0755 for directories and executables and 0644
// for the rest. .git and .DS_Store are left out; a symlink or other special file is an
// error (the installer refuses them).
func Write(dir string, w io.Writer) error {
	gz, err := gzip.NewWriterLevel(w, gzip.BestCompression)
	if err != nil {
		return err
	}
	tw := tar.NewWriter(gz)
	var paths []string
	err = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p == dir {
			return nil
		}
		if slices.Contains(skipped, d.Name()) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		paths = append(paths, p)
		return nil
	})
	if err != nil {
		return err
	}
	slices.Sort(paths)
	epoch := time.Unix(0, 0)
	for _, p := range paths {
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		name := filepath.ToSlash(rel)
		fi, err := os.Lstat(p)
		if err != nil {
			return err
		}
		h := &tar.Header{Name: name, ModTime: epoch, Format: tar.FormatPAX}
		switch {
		case fi.IsDir():
			h.Typeflag, h.Name, h.Mode = tar.TypeDir, name+"/", 0o755
		case fi.Mode().IsRegular():
			h.Typeflag, h.Size, h.Mode = tar.TypeReg, fi.Size(), 0o644
			if fi.Mode().Perm()&0o111 != 0 {
				h.Mode = 0o755
			}
		default:
			return fmt.Errorf("%s is not a regular file or directory (%s): links are not packed", name, fi.Mode().Type())
		}
		if err := tw.WriteHeader(h); err != nil {
			return err
		}
		if h.Typeflag == tar.TypeReg {
			if err := copyFile(tw, p); err != nil {
				return err
			}
		}
	}
	if err := tw.Close(); err != nil {
		return err
	}
	return gz.Close()
}

func copyFile(w io.Writer, p string) error {
	f, err := os.Open(p)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	_, err = io.Copy(w, f)
	return err
}

type countWriter struct {
	w io.Writer
	n int64
}

func (c *countWriter) Write(b []byte) (int, error) {
	n, err := c.w.Write(b)
	c.n += int64(n)
	return n, err
}

// WriteChecksums adds the results to outDir/checksums.txt, replacing lines for the same
// files and keeping the others, sorted by file name.
func WriteChecksums(outDir string, results ...Result) error {
	file := filepath.Join(outDir, ChecksumsFile)
	sums := map[string]string{}
	if data, err := os.ReadFile(file); err == nil {
		sc := bufio.NewScanner(strings.NewReader(string(data)))
		for sc.Scan() {
			if f := strings.Fields(sc.Text()); len(f) == 2 {
				sums[strings.TrimPrefix(f[1], "*")] = f[0]
			}
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	for _, r := range results {
		sums[r.Base] = r.SHA256
	}
	names := make([]string, 0, len(sums))
	for n := range sums {
		names = append(names, n)
	}
	slices.Sort(names)
	var b strings.Builder
	for _, n := range names {
		b.WriteString(sums[n] + "  " + n + "\n")
	}
	return os.WriteFile(file, []byte(b.String()), 0o644)
}

// Artifact is one platform's tarball in a registry entry.
type Artifact struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
}

// Entry is a registry entry (plugins/<name>.json in a registry repository).
type Entry struct {
	Name        string                `json:"name"`
	DisplayName string                `json:"displayName,omitempty"`
	Description string                `json:"description,omitempty"`
	Repo        string                `json:"repo"`
	Version     string                `json:"version"`
	Protocol    int                   `json:"protocol"`
	Permissions pluginsdk.Permissions `json:"permissions"`
	Artifacts   map[string]Artifact   `json:"artifacts"`
}

// ReleaseURL is where a tarball is downloaded from a GitHub release tagged v<version>.
func ReleaseURL(repo, version, base string) string {
	return "https://github.com/" + repo + "/releases/download/v" + version + "/" + base
}

// MakeEntry builds the registry entry for results (one per platform, all of one plugin
// version). urlFor gives each tarball's download URL (ReleaseURL for a GitHub release).
func MakeEntry(repo string, results []Result, urlFor func(Result) string) (Entry, error) {
	if len(results) == 0 {
		return Entry{}, errors.New("no tarballs")
	}
	m := results[0].Manifest
	e := Entry{
		Name: m.Name, DisplayName: m.DisplayName, Description: m.Description, Repo: repo, Version: m.Version,
		Protocol: m.Protocol, Permissions: m.Permissions.Normalize(), Artifacts: map[string]Artifact{},
	}
	for _, r := range results {
		if r.Name != e.Name || r.Version != e.Version {
			return Entry{}, fmt.Errorf("%s is %s %s, not %s %s", r.Base, r.Name, r.Version, e.Name, e.Version)
		}
		if !r.Manifest.Permissions.Equal(m.Permissions) {
			return Entry{}, fmt.Errorf("%s asks for other permissions than %s", r.Base, results[0].Base)
		}
		if _, dup := e.Artifacts[r.Platform]; dup {
			return Entry{}, fmt.Errorf("two tarballs for %s", r.Platform)
		}
		e.Artifacts[r.Platform] = Artifact{URL: urlFor(r), SHA256: r.SHA256}
	}
	return e, nil
}

// MarshalEntry is the entry as the registry keeps it: indented JSON with a newline.
func MarshalEntry(e Entry) ([]byte, error) {
	b, err := json.MarshalIndent(e, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}
