package registry_test

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/plugin/registry"
	"github.com/alexwaumann/code-foundry/internal/store/plugin/registry/registrytest"
)

const sha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func entryJSON(name, version string) string {
	return fmt.Sprintf(`{"name":%q,"displayName":"D %s","version":%q,"protocol":1,"repo":"o/%s",
		"permissions":{"events":["threads","gh"]},"future":true,
		"artifacts":{"darwin/arm64":{"url":"https://github.com/o/%s/releases/download/v%s/%s-%s-darwin-arm64.tar.gz","sha256":%q}}}`,
		name, name, version, name, name, version, name, version, sha)
}

func TestParse(t *testing.T) {
	tests := []struct {
		name       string
		body       string
		wantErr    string
		wantNames  []string
		wantIssues []string
	}{
		{name: "empty registry", body: `{"schema":1,"generatedAt":"2026-10-18T09:46:42Z","plugins":[]}`},
		{name: "entries sorted, unknown fields ignored", body: `{"schema":1,"x":2,"plugins":[` + entryJSON("zed", "1.0.0") + `,` + entryJSON("alpha", "0.1.0") + `]}`,
			wantNames: []string{"alpha", "zed"}},
		{name: "bad entries skipped", body: `{"schema":1,"plugins":[` + entryJSON("ok", "1.0.0") + `,` + entryJSON("Bad", "1.0.0") + `,` +
			entryJSON("v", "v1.0.0") + `,{"name":"noart","version":"1.0.0"},` + entryJSON("ok", "2.0.0") + `,7]}`,
			wantNames: []string{"ok"}, wantIssues: []string{"plugins[1] (Bad): name", "plugins[2] (v): version", "plugins[3] (noart): no artifacts", "plugins[4]: ok is listed twice", "plugins[5]: json"}},
		{name: "newer schema", body: `{"schema":2,"plugins":[]}`, wantIssues: []string{"schema 2 is newer"}},
		{name: "http artifact refused", body: `{"plugins":[{"name":"x","version":"1.0.0","artifacts":{"darwin/arm64":{"url":"http://example.com/x.tgz","sha256":"` + sha + `"}}}]}`,
			wantIssues: []string{"plain http only for localhost"}},
		{name: "loopback http artifact", body: `{"plugins":[{"name":"x","version":"1.0.0","artifacts":{"darwin/arm64":{"url":"http://127.0.0.1:9/x.tgz","sha256":"` + strings.ToUpper(sha) + `"}}}]}`,
			wantNames: []string{"x"}},
		{name: "not json", body: `<html>`, wantErr: "index.json"},
		{name: "no plugins list", body: `{"schema":1}`, wantErr: "no plugins list"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			idx, issues, err := registry.Parse([]byte(tt.body))
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			var names []string
			for _, e := range idx.Plugins {
				names = append(names, e.Name)
			}
			if strings.Join(names, ",") != strings.Join(tt.wantNames, ",") {
				t.Errorf("names = %v, want %v", names, tt.wantNames)
			}
			if len(issues) != len(tt.wantIssues) {
				t.Fatalf("issues = %q, want %q", issues, tt.wantIssues)
			}
			for i, w := range tt.wantIssues {
				if !strings.Contains(issues[i], w) {
					t.Errorf("issue %d = %q, want %q", i, issues[i], w)
				}
			}
		})
	}
}

func TestParseLocation(t *testing.T) {
	tests := []struct {
		in, url, repo, index, err string
	}{
		{in: "https://github.com/alexwaumann/code-foundry-plugins", url: "https://github.com/alexwaumann/code-foundry-plugins", repo: "alexwaumann/code-foundry-plugins"},
		{in: " https://github.com/o/r.git/ ", url: "https://github.com/o/r", repo: "o/r"},
		{in: "o/r", url: "https://github.com/o/r", repo: "o/r"},
		{in: "https://plugins.example.com/index.json", url: "https://plugins.example.com/index.json", index: "https://plugins.example.com/index.json"},
		{in: "https://plugins.example.com/team/", url: "https://plugins.example.com/team", index: "https://plugins.example.com/team/index.json"},
		{in: "http://127.0.0.1:8080/index.json", url: "http://127.0.0.1:8080/index.json", index: "http://127.0.0.1:8080/index.json"},
		{in: "http://plugins.example.com/index.json", err: "plain http only for localhost"},
		{in: "https://github.com/o", err: "want https://github.com/<owner>/<repo>"},
		{in: "https://github.com/o/r/tree/main", err: "want https://github.com/<owner>/<repo>"},
		{in: "ftp://x/index.json", err: "scheme"},
		{in: "https://user:pw@example.com/index.json", err: "no credentials"},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			loc, err := registry.ParseLocation(tt.in)
			if tt.err != "" {
				if err == nil || !strings.Contains(err.Error(), tt.err) {
					t.Fatalf("err = %v, want %q", err, tt.err)
				}
				return
			}
			if err != nil || loc.URL != tt.url || loc.Repo != tt.repo || loc.IndexURL != tt.index {
				t.Errorf("= %+v, %v; want url %q repo %q index %q", loc, err, tt.url, tt.repo, tt.index)
			}
		})
	}
	locs, err := registry.ParseList("o/a, https://github.com/o/a\nhttps://x.example/index.json")
	if err != nil || len(locs) != 2 || locs[1].IndexURL != "https://x.example/index.json" {
		t.Errorf("ParseList = %+v, %v", locs, err)
	}
	if locs, err := registry.ParseList("none"); err != nil || len(locs) != 0 {
		t.Errorf("ParseList(none) = %+v, %v", locs, err)
	}
	if _, err := registry.ParseList("o/a, http://evil.example/index.json"); err == nil {
		t.Error("ParseList should report the bad URL")
	}
}

func TestParseReleaseURL(t *testing.T) {
	a, ok := registry.ParseReleaseURL("https://github.com/o/r/releases/download/v1.0.0/x-1.0.0-darwin-arm64.tar.gz")
	if !ok || a != (registry.ReleaseAsset{Repo: "o/r", Tag: "v1.0.0", Name: "x-1.0.0-darwin-arm64.tar.gz"}) {
		t.Errorf("= %+v, %v", a, ok)
	}
	for _, u := range []string{"https://example.com/o/r/releases/download/v1/x", "https://github.com/o/r/archive/v1.tar.gz", "http://github.com/o/r/releases/download/v1/x"} {
		if _, ok := registry.ParseReleaseURL(u); ok {
			t.Errorf("%s parsed as a release asset", u)
		}
	}
}

type clock struct{ t atomic.Int64 }

func (c *clock) now() time.Time      { return time.Unix(0, c.t.Load()) }
func (c *clock) add(d time.Duration) { c.t.Add(int64(d)) }

func TestClientCacheAndMerge(t *testing.T) {
	var hits atomic.Int32
	var body atomic.Value
	body.Store(`{"schema":1,"plugins":[` + entryJSON("shared", "9.0.0") + `,` + entryJSON("web", "1.0.0") + `]}`)
	var fail atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if fail.Load() {
			http.Error(w, "down", http.StatusBadGateway)
			return
		}
		_, _ = w.Write([]byte(body.Load().(string)))
	}))
	defer srv.Close()
	gh := registrytest.NewGh()
	gh.Indexes["o/main"] = `{"schema":1,"plugins":[` + entryJSON("shared", "1.0.0") + `,` + entryJSON("hello", "0.1.0") + `]}`
	clk := &clock{}
	clk.t.Store(time.Date(2026, 10, 18, 9, 0, 0, 0, time.UTC).UnixNano())
	cache := t.TempDir()
	newClient := func() *registry.Client {
		c := registry.NewClient(registry.Options{CacheDir: cache, Fetcher: registry.Fetcher{Gh: gh, HTTP: srv.Client()}, Now: clk.now, Log: slog.New(slog.DiscardHandler)})
		locs, err := registry.ParseList("o/main, " + srv.URL + "/index.json, o/missing")
		if err != nil {
			t.Fatal(err)
		}
		c.SetLocations(locs)
		return c
	}
	c := newClient()
	m := c.Read(context.Background(), false)
	if got := names(m); got != "hello@0.1.0(o/main) shared@1.0.0(o/main) web@1.0.0(127)" {
		t.Errorf("merged = %s", got)
	}
	if len(m.Registries) != 3 || m.Registries[0].Plugins != 2 || m.Registries[0].Cached ||
		len(m.Registries[1].Issues) != 1 || !strings.Contains(m.Registries[1].Issues[0], "shared: already listed by https://github.com/o/main") ||
		!strings.Contains(m.Registries[2].Error, "no index.json in o/missing") {
		t.Errorf("statuses = %+v", m.Registries)
	}
	if m.Err() == nil {
		t.Error("Err should report o/missing")
	}
	fp := m.Fingerprint()

	// Within the TTL: the cache, no requests.
	clk.add(30 * time.Minute)
	before := hits.Load()
	m = c.Read(context.Background(), false)
	if hits.Load() != before || !m.Registries[0].Cached || !m.Registries[1].Cached || m.Fingerprint() != fp {
		t.Errorf("fresh cache: hits %d -> %d, statuses %+v", before, hits.Load(), m.Registries)
	}
	// Refresh fetches again.
	body.Store(`{"schema":1,"plugins":[` + entryJSON("web", "1.1.0") + `]}`)
	m = c.Read(context.Background(), true)
	if hits.Load() != before+1 || m.Registries[1].Cached {
		t.Errorf("refresh: hits %d, statuses %+v", hits.Load(), m.Registries)
	}
	if e, _ := m.Entry("web"); e.Version != "1.1.0" || m.Fingerprint() == fp {
		t.Errorf("web = %+v", e)
	}
	// Past the TTL with the server down: the stale cache, and the error.
	clk.add(2 * time.Hour)
	fail.Store(true)
	m = c.Read(context.Background(), false)
	if e, ok := m.Entry("web"); !ok || e.Version != "1.1.0" || !m.Registries[1].Cached || !strings.Contains(m.Registries[1].Error, "HTTP 502") {
		t.Errorf("stale: %+v %+v", e, m.Registries[1])
	}
	// A new client (a daemon restart) reads the cache without the network.
	before = hits.Load()
	calls := len(gh.Calls())
	m = newClient().Cached()
	if hits.Load() != before || len(gh.Calls()) != calls || names(m) != "hello@0.1.0(o/main) shared@1.0.0(o/main) web@1.1.0(127)" {
		t.Errorf("cached: %s, hits %d -> %d", names(m), before, hits.Load())
	}
	// Changing the registries: the first one listed wins.
	locs, _ := registry.ParseList(srv.URL + "/index.json, o/main")
	if !c.SetLocations(locs) || c.SetLocations(locs) {
		t.Error("SetLocations should report a change once")
	}
}

func names(m registry.Merged) string {
	var out []string
	for _, e := range m.Entries {
		src := strings.TrimPrefix(e.Registry, "https://github.com/")
		if strings.HasPrefix(src, "http://127") {
			src = "127"
		}
		out = append(out, e.Name+"@"+e.Version+"("+src+")")
	}
	return strings.Join(out, " ")
}

func targz(t *testing.T, entries []tar.Header, bodies map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, h := range entries {
		b := bodies[h.Name]
		if h.Typeflag == tar.TypeReg {
			h.Size = int64(len(b))
		}
		if err := tw.WriteHeader(&h); err != nil {
			t.Fatal(err)
		}
		if b != "" && h.Typeflag == tar.TypeReg {
			if _, err := tw.Write([]byte(b)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestExtract(t *testing.T) {
	reg := func(name string, mode int64) tar.Header {
		return tar.Header{Name: name, Typeflag: tar.TypeReg, Mode: mode}
	}
	tests := []struct {
		name    string
		entries []tar.Header
		wantErr string
		check   func(t *testing.T, dir string)
	}{
		{name: "package at root", entries: []tar.Header{
			{Name: "./", Typeflag: tar.TypeDir, Mode: 0o755}, reg("./plugin.json", 0o600), {Name: "bin/", Typeflag: tar.TypeDir, Mode: 0o700}, reg("bin/x", 0o700),
		}, check: func(t *testing.T, dir string) {
			fi, err := os.Stat(filepath.Join(dir, "bin", "x"))
			if err != nil || fi.Mode().Perm() != 0o755 {
				t.Errorf("bin/x = %v, %v", fi, err)
			}
			if fi, err := os.Stat(filepath.Join(dir, "plugin.json")); err != nil || fi.Mode().Perm() != 0o644 {
				t.Errorf("plugin.json = %v, %v", fi, err)
			}
		}},
		{name: "parent dir", entries: []tar.Header{reg("../evil", 0o644)}, wantErr: "leaves the package directory"},
		{name: "nested parent", entries: []tar.Header{reg("bin/../../evil", 0o644)}, wantErr: "leaves the package directory"},
		{name: "absolute", entries: []tar.Header{reg("/etc/evil", 0o644)}, wantErr: "absolute name"},
		{name: "symlink", entries: []tar.Header{{Name: "bin/x", Typeflag: tar.TypeSymlink, Linkname: "/bin/sh"}}, wantErr: "links and devices are not allowed"},
		{name: "hard link", entries: []tar.Header{reg("a", 0o644), {Name: "b", Typeflag: tar.TypeLink, Linkname: "a"}}, wantErr: "links and devices"},
		{name: "duplicate", entries: []tar.Header{reg("a", 0o644), reg("./a", 0o644)}, wantErr: "appears twice"},
		{name: "backslash", entries: []tar.Header{reg(`..\evil`, 0o644)}, wantErr: "backslash"},
		{name: "fifo", entries: []tar.Header{{Name: "p", Typeflag: tar.TypeFifo}}, wantErr: "links and devices"},
		{name: "char device", entries: []tar.Header{{Name: "d", Typeflag: tar.TypeChar, Devmajor: 1}}, wantErr: "links and devices"},
		{name: "setuid and sticky bits dropped", entries: []tar.Header{{Name: "bin/", Typeflag: tar.TypeDir, Mode: 0o1777}, reg("bin/x", 0o6777)},
			check: func(t *testing.T, dir string) {
				for name, want := range map[string]os.FileMode{"bin": os.ModeDir | 0o755, "bin/x": 0o755} {
					fi, err := os.Stat(filepath.Join(dir, name))
					if err != nil || fi.Mode() != want {
						t.Errorf("%s mode = %v, %v; want %v", name, fi.Mode(), err, want)
					}
				}
			}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tmp := t.TempDir()
			file := filepath.Join(tmp, "x.tar.gz")
			if err := os.WriteFile(file, targz(t, tt.entries, map[string]string{"./plugin.json": "{}", "bin/x": "#!/bin/sh", "a": "a"}), 0o600); err != nil {
				t.Fatal(err)
			}
			dir := filepath.Join(tmp, "pkg")
			if err := os.Mkdir(dir, 0o700); err != nil {
				t.Fatal(err)
			}
			err := registry.Extract(file, dir)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want %q", err, tt.wantErr)
				}
				if _, err := os.Stat(filepath.Join(tmp, "evil")); err == nil {
					t.Error("wrote outside the directory")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			tt.check(t, dir)
		})
	}
	bad := filepath.Join(t.TempDir(), "bad.tar.gz")
	_ = os.WriteFile(bad, []byte("not gzip"), 0o600)
	if err := registry.Extract(bad, t.TempDir()); err == nil || !strings.Contains(err.Error(), "not a gzip file") {
		t.Errorf("not gzip: %v", err)
	}
}

func TestDownloadAndVerify(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/x.tgz" {
			_, _ = w.Write([]byte("tarball"))
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()
	dir := t.TempDir()
	asset := filepath.Join(dir, "asset")
	_ = os.WriteFile(asset, []byte("from gh"), 0o600)
	gh := registrytest.NewGh()
	gh.Assets["o/r/v1.0.0/x-1.0.0-darwin-arm64.tar.gz"] = asset
	f := registry.Fetcher{Gh: gh, HTTP: srv.Client()}
	ctx := context.Background()

	dst := filepath.Join(dir, "dl")
	var seen int64
	if err := f.Download(ctx, srv.URL+"/x.tgz", dst, func(n int64) { seen = n }); err != nil || seen != 7 {
		t.Fatalf("http download: %v (progress %d)", err, seen)
	}
	sum, _ := registry.SHA256File(dst)
	if err := registry.Verify(dst, strings.ToUpper(sum)); err != nil {
		t.Errorf("verify: %v", err)
	}
	if err := registry.Verify(dst, sha); !errors.Is(err, registry.ErrHashMismatch) {
		t.Errorf("verify wrong hash: %v", err)
	}
	if err := f.Download(ctx, srv.URL+"/nope", dst, nil); !errors.Is(err, registry.ErrNotFound) {
		t.Errorf("404: %v", err)
	}
	if err := f.Download(ctx, "https://github.com/o/r/releases/download/v1.0.0/x-1.0.0-darwin-arm64.tar.gz", dst, nil); err != nil {
		t.Fatalf("gh download: %v", err)
	}
	if b, _ := os.ReadFile(dst); string(b) != "from gh" {
		t.Errorf("gh download wrote %q", b)
	}
	if err := f.Download(ctx, "https://github.com/o/r/releases/download/v2.0.0/x.tar.gz", dst, nil); !errors.Is(err, registry.ErrNotFound) {
		t.Errorf("gh missing asset: %v", err)
	}
	if err := f.Download(ctx, "http://example.com/x.tgz", dst, nil); err == nil {
		t.Error("plain http to a remote host should be refused")
	}
}

func TestResolveRelease(t *testing.T) {
	dir := t.TempDir()
	sums := filepath.Join(dir, "checksums.txt")
	_ = os.WriteFile(sums, []byte("ffff  other.tar.gz\n"+sha+"  hello-0.2.0-darwin-arm64.tar.gz\n"), 0o600)
	gh := registrytest.NewGh()
	rel := func(tag string, assets ...string) string {
		var parts []string
		for _, a := range assets {
			parts = append(parts, fmt.Sprintf(`{"name":%q,"url":"https://github.com/o/hello/releases/download/%s/%s"}`, a, tag, a))
		}
		return fmt.Sprintf(`{"tagName":%q,"assets":[%s]}`, tag, strings.Join(parts, ","))
	}
	gh.Releases["o/hello@"] = rel("v0.2.0", "hello-0.2.0-darwin-arm64.tar.gz", "hello-0.2.0-darwin-amd64.tar.gz", "checksums.txt")
	gh.Assets["o/hello/v0.2.0/checksums.txt"] = sums
	gh.Releases["o/hello@v0.1.0"] = rel("v0.1.0", "hello-0.1.0-darwin-arm64.tar.gz")
	gh.Releases["o/hello@v0.3.0"] = rel("v0.3.0", "hello-0.3.0-darwin-arm64.tar.gz", "checksums.txt")
	gh.Assets["o/hello/v0.3.0/checksums.txt"] = sums // does not list 0.3.0
	gh.Releases["o/hello@v9"] = rel("v9", "x")
	// The plugin skill's make dist publishes SHA256SUMS.
	sums4 := filepath.Join(dir, "SHA256SUMS")
	_ = os.WriteFile(sums4, []byte(sha+"  hello-0.4.0-darwin-arm64.tar.gz\n"), 0o600)
	gh.Releases["o/hello@v0.4.0"] = rel("v0.4.0", "SHA256SUMS", "hello-0.4.0-darwin-arm64.tar.gz")
	gh.Assets["o/hello/v0.4.0/SHA256SUMS"] = sums4
	f := registry.Fetcher{Gh: gh}
	tests := []struct {
		tag, platform string
		want          registry.Release
		wantErr       string
	}{
		{tag: "", platform: "darwin/arm64", want: registry.Release{Repo: "o/hello", Tag: "v0.2.0", Name: "hello", Version: "0.2.0",
			AssetName: "hello-0.2.0-darwin-arm64.tar.gz", Checksums: "checksums.txt",
			Asset: registry.Artifact{URL: "https://github.com/o/hello/releases/download/v0.2.0/hello-0.2.0-darwin-arm64.tar.gz", SHA256: sha}}},
		{tag: "v0.1.0", platform: "darwin/arm64", want: registry.Release{Repo: "o/hello", Tag: "v0.1.0", Name: "hello", Version: "0.1.0",
			AssetName: "hello-0.1.0-darwin-arm64.tar.gz",
			Asset:     registry.Artifact{URL: "https://github.com/o/hello/releases/download/v0.1.0/hello-0.1.0-darwin-arm64.tar.gz"}}},
		{tag: "v0.4.0", platform: "darwin/arm64", want: registry.Release{Repo: "o/hello", Tag: "v0.4.0", Name: "hello", Version: "0.4.0",
			AssetName: "hello-0.4.0-darwin-arm64.tar.gz", Checksums: "SHA256SUMS",
			Asset: registry.Artifact{URL: "https://github.com/o/hello/releases/download/v0.4.0/hello-0.4.0-darwin-arm64.tar.gz", SHA256: sha}}},
		{tag: "v0.1.0", platform: "darwin/amd64", wantErr: "no <name>-0.1.0-darwin-amd64.tar.gz tarball"},
		{tag: "v0.3.0", platform: "darwin/arm64", wantErr: "does not list hello-0.3.0-darwin-arm64.tar.gz"},
		{tag: "v9", platform: "darwin/arm64", wantErr: "not v<semver>"},
		{tag: "v5.0.0", platform: "darwin/arm64", wantErr: "has no release v5.0.0"},
	}
	for _, tt := range tests {
		t.Run(tt.tag+" "+tt.platform, func(t *testing.T) {
			r, err := f.ResolveRelease(context.Background(), "o/hello", tt.tag, tt.platform, dir)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want %q", err, tt.wantErr)
				}
				return
			}
			if err != nil || r != tt.want {
				t.Errorf("= %+v, %v\nwant %+v", r, err, tt.want)
			}
		})
	}
}

func TestFindChecksum(t *testing.T) {
	tests := []struct {
		data, file, want string
		ok               bool
	}{
		{data: sha + "  a.tar.gz\n", file: "a.tar.gz", want: sha, ok: true},
		{data: strings.ToUpper(sha) + " *dist/a.tar.gz\n", file: "a.tar.gz", want: sha, ok: true},
		{data: sha + "\n", file: "a.tar.gz", want: sha, ok: true},
		{data: sha + "  b.tar.gz\n", file: "a.tar.gz"},
		{data: "garbage", file: "a.tar.gz"},
	}
	for _, tt := range tests {
		got, ok := registry.FindChecksum([]byte(tt.data), tt.file)
		if got != tt.want || ok != tt.ok {
			t.Errorf("FindChecksum(%q, %s) = %q, %v", tt.data, tt.file, got, ok)
		}
	}
}

func TestFingerprint(t *testing.T) {
	none := registry.Merged{}
	reg := registry.Merged{Registries: []registry.Status{{URL: "https://github.com/o/reg"}}}
	listed := registry.Merged{Registries: reg.Registries, Entries: []registry.Entry{{Name: "hello", Version: "0.1.0", Registry: "https://github.com/o/reg"}}}
	bumped := registry.Merged{Registries: reg.Registries, Entries: []registry.Entry{{Name: "hello", Version: "0.2.0", Registry: "https://github.com/o/reg"}}}
	tests := []struct {
		name string
		a, b registry.Merged
		same bool
	}{
		{name: "unchanged", a: listed, b: listed, same: true},
		{name: "first registry configured, nothing fetched yet", a: none, b: reg},
		{name: "an entry listed", a: reg, b: listed},
		{name: "an entry bumped", a: listed, b: bumped},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if same := tt.a.Fingerprint() == tt.b.Fingerprint(); same != tt.same {
				t.Errorf("same = %v, want %v", same, tt.same)
			}
		})
	}
}
