package registry

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/store/update"
)

// Fuzz targets for registry indexes, release tarballs, versions and URLs
// (docs/notes/plugins-9-fuzz.md). `make fuzz` runs each briefly; regression inputs live
// in testdata/fuzz/<target>/.

const fuzzSHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func FuzzParseIndex(f *testing.F) {
	f.Add([]byte(`{"schema":1,"plugins":[{"name":"hello","version":"1.0.0","protocol":1,"permissions":{"commands":["thread.send"]},
		"artifacts":{"darwin/arm64":{"url":"https://github.com/o/r/releases/download/v1.0.0/hello-1.0.0-darwin-arm64.tar.gz","sha256":"` + fuzzSHA + `"}}}]}`))
	f.Add([]byte(`{"schema":9,"plugins":[{"name":"x"},{"name":"x","version":"1.0.0","artifacts":{"a/b":{"url":"http://127.0.0.1/x","sha256":"` + strings.ToUpper(fuzzSHA) + `"}}}],"extra":1}`))
	f.Add([]byte(`{"plugins":null}`))
	f.Fuzz(func(t *testing.T, data []byte) {
		idx, _, err := Parse(data)
		if err != nil {
			return
		}
		seen := map[string]bool{}
		for i, e := range idx.Plugins {
			if err := e.Validate(); err != nil {
				t.Fatalf("an entry that does not validate was kept: %v", err)
			}
			if seen[e.Name] {
				t.Fatalf("%s listed twice", e.Name)
			}
			seen[e.Name] = true
			if i > 0 && idx.Plugins[i-1].Name > e.Name {
				t.Fatal("not sorted")
			}
			for plat, a := range e.Artifacts {
				u, err := url.Parse(a.URL)
				if err != nil || (u.Scheme != "https" && !(u.Scheme == "http" && isLoopback(u.Hostname()))) {
					t.Fatalf("artifact %s url %q passed", plat, a.URL)
				}
				if rel, ok := ParseReleaseURL(a.URL); ok && (strings.HasPrefix(rel.Tag, "-") || strings.HasPrefix(rel.Name, "-")) {
					t.Fatalf("release asset %+v would reach gh as a flag", rel)
				}
				_ = TarballName(e.Name, e.Version, plat)
			}
			if !ValidVersion(e.Version) || Newer(e.Version, e.Version) {
				t.Fatalf("version %q", e.Version)
			}
		}
	})
}

func FuzzVersion(f *testing.F) {
	f.Add("1.0.0", "1.0.0-rc.1")
	f.Add("1.0.0-alpha.1", "1.0.0-alpha.beta")
	f.Add("99999999999999999999.0.0", "0.0.0")
	f.Add("1.2.3+build", "v1.2.3")
	f.Fuzz(func(t *testing.T, a, b string) {
		va, errA := update.ParseVersion(a)
		vb, errB := update.ParseVersion(b)
		if errA != nil || errB != nil {
			if Newer(a, b) || Newer(b, a) {
				t.Fatalf("a malformed version is newer: %q %q", a, b)
			}
			return
		}
		ab, ba := va.Compare(vb), vb.Compare(va)
		if ab != -ba {
			t.Fatalf("Compare not antisymmetric: %q %q: %d %d", a, b, ab, ba)
		}
		if va.Compare(va) != 0 {
			t.Fatalf("%q not equal to itself", a)
		}
		if Newer(a, b) != (ab > 0) {
			t.Fatalf("Newer(%q, %q) = %v, Compare %d", a, b, Newer(a, b), ab)
		}
	})
}

func FuzzParseLocation(f *testing.F) {
	for _, s := range []string{
		"alexwaumann/code-foundry-plugins", "https://github.com/o/r.git/", "https://www.GitHub.com/o/r",
		"http://localhost:8080/reg", "http://[::1]/x.json", "https://u:p@example.com/x", "ftp://x", "https://example.com/a?b",
		"https://raw.githubusercontent.com/o/r/main/index.json", "http://127.0.0.1.nip.io/", "https://github.com/o/r/releases/download/--x/-y",
	} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, raw string) {
		if loc, err := ParseLocation(raw); err == nil {
			for _, s := range []string{loc.URL, loc.IndexURL} {
				if s == "" {
					continue
				}
				u, err := url.Parse(s)
				if err != nil || (u.Scheme != "https" && !(u.Scheme == "http" && isLoopback(u.Hostname()))) || u.User != nil {
					t.Fatalf("location %+v from %q", loc, raw)
				}
			}
			if loc.Repo != "" && !repoPattern.MatchString(loc.Repo) {
				t.Fatalf("repo %q", loc.Repo)
			}
		}
		if rel, ok := ParseReleaseURL(raw); ok {
			if !repoPattern.MatchString(rel.Repo) || rel.Tag == "" || rel.Name == "" || strings.HasPrefix(rel.Tag, "-") || strings.HasPrefix(rel.Name, "-") {
				t.Fatalf("release %+v from %q", rel, raw)
			}
		}
		_, _ = ParseList(raw + "," + raw)
		_, _, _ = ParseRepoRef(raw)
	})
}

func FuzzFindChecksum(f *testing.F) {
	f.Add([]byte(fuzzSHA+"  x.tar.gz\n"+fuzzSHA+" *dir/y.tar.gz\n"), "y.tar.gz")
	f.Add([]byte(strings.ToUpper(fuzzSHA)+"\n"), "z")
	f.Fuzz(func(t *testing.T, data []byte, file string) {
		if sum, ok := FindChecksum(data, file); ok && !sha256Hex.MatchString(sum) {
			t.Fatalf("checksum %q", sum)
		}
	})
}

// tarEntry kinds the structured extract fuzzer writes.
var tarTypes = []byte{tar.TypeReg, tar.TypeDir, tar.TypeSymlink, tar.TypeLink, tar.TypeChar, tar.TypeBlock, tar.TypeFifo,
	tar.TypeXGlobalHeader, tar.TypeGNUSparse, tar.TypeCont, 'Z'}

var tarNames = []string{
	"plugin.json", "./plugin.json", "bin/", "bin/x", "bin//x", "../evil", "/etc/evil", "bin/../../evil", "a\\b", ".", "./",
	"..", "a/./b", "bin", "BIN/x", strings.Repeat("d/", 60) + "f", "é/ü", "a\x00b", " ", "bin/x/", "-rf",
}

// buildTar writes a tar.gz from spec: each 3 bytes are a type, a name and a size.
func buildTar(spec []byte) []byte {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for len(spec) >= 3 {
		h := tar.Header{
			Typeflag: tarTypes[int(spec[0])%len(tarTypes)], Name: tarNames[int(spec[1])%len(tarNames)],
			Mode: int64(spec[2]) << 3, Linkname: "/bin/sh", Format: tar.FormatPAX,
		}
		size := int(spec[2]) * 7
		if h.Typeflag == tar.TypeReg {
			h.Size = int64(size)
		}
		spec = spec[3:]
		if tw.WriteHeader(&h) != nil {
			continue
		}
		if h.Typeflag == tar.TypeReg {
			_, _ = tw.Write(bytes.Repeat([]byte{'x'}, size))
		}
	}
	_ = tw.Close()
	_ = gz.Close()
	return buf.Bytes()
}

// checkExtracted fails if anything landed outside dir or dir holds anything but
// directories and regular files of mode 0644/0755.
func checkExtracted(t *testing.T, parent, dir string) {
	entries, _ := os.ReadDir(parent)
	for _, e := range entries {
		if e.Name() != "pkg" && e.Name() != "x.tar.gz" {
			t.Fatalf("wrote %s outside the package directory", e.Name())
		}
	}
	var total int64
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		fi, err := os.Lstat(p)
		if err != nil {
			return err
		}
		switch {
		case fi.Mode().IsDir():
		case fi.Mode().IsRegular():
			if perm := fi.Mode().Perm(); perm != 0o644 && perm != 0o755 || fi.Mode()&(fs.ModeSetuid|fs.ModeSetgid|fs.ModeSticky) != 0 {
				t.Fatalf("%s has mode %v", p, fi.Mode())
			}
			total += fi.Size()
		default:
			t.Fatalf("%s is a %v", p, fi.Mode().Type())
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if total > MaxUnpackedBytes {
		t.Fatalf("unpacked %d bytes", total)
	}
}

func FuzzExtract(f *testing.F) {
	f.Add([]byte{0, 0, 5, 1, 2, 0, 0, 3, 9})
	f.Add([]byte{2, 3, 0})
	f.Add([]byte{0, 5, 1, 0, 6, 1, 0, 7, 1})
	f.Add([]byte{3, 3, 0, 0, 4, 1})
	f.Fuzz(func(t *testing.T, spec []byte) {
		parent := t.TempDir()
		file := filepath.Join(parent, "x.tar.gz")
		if err := os.WriteFile(file, buildTar(spec), 0o600); err != nil {
			t.Fatal(err)
		}
		dir := filepath.Join(parent, "pkg")
		if err := os.Mkdir(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		_ = Extract(file, dir)
		checkExtracted(t, parent, dir)
	})
}

// FuzzExtractBytes feeds raw bytes (seeded with real tarballs) as the tarball.
func FuzzExtractBytes(f *testing.F) {
	f.Add(buildTar([]byte{1, 2, 0, 0, 3, 9, 0, 0, 5}))
	f.Add(buildTar([]byte{2, 3, 0}))
	f.Add([]byte("not gzip"))
	f.Fuzz(func(t *testing.T, data []byte) {
		parent := t.TempDir()
		file := filepath.Join(parent, "x.tar.gz")
		if err := os.WriteFile(file, data, 0o600); err != nil {
			t.Fatal(err)
		}
		dir := filepath.Join(parent, "pkg")
		if err := os.Mkdir(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		_ = Extract(file, dir)
		checkExtracted(t, parent, dir)
	})
}
