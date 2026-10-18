package pack_test

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/pluginsdk/pack"
)

const manifest = `{"name":"demo","version":"1.2.3","protocol":1,"exec":["bin/demo"],
 "permissions":{"events":["threads"],"commands":["thread.send"]}}`

func writePkg(t *testing.T, files map[string]string, exec bool) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range files {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		mode := os.FileMode(0o644)
		if exec && strings.HasPrefix(name, "bin/") {
			mode = 0o755
		}
		if err := os.WriteFile(p, []byte(body), mode); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func entries(t *testing.T, file string) map[string]int64 {
	t.Helper()
	f, err := os.Open(file)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	gz, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(gz)
	out := map[string]int64{}
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return out
		}
		if err != nil {
			t.Fatal(err)
		}
		out[h.Name] = h.Mode
	}
}

func TestTarball(t *testing.T) {
	tests := []struct {
		name    string
		files   map[string]string
		exec    bool
		wantErr string
		want    map[string]int64
	}{
		{name: "package", exec: true,
			files: map[string]string{"plugin.json": manifest, "bin/demo": "#!/bin/sh\n", ".git/HEAD": "x", "README.md": "hi"},
			want:  map[string]int64{"README.md": 0o644, "bin/": 0o755, "bin/demo": 0o755, "plugin.json": 0o644}},
		{name: "no manifest", files: map[string]string{"bin/demo": "x"}, exec: true, wantErr: "plugin.json"},
		{name: "exec missing", files: map[string]string{"plugin.json": manifest}, wantErr: "exec bin/demo"},
		{name: "exec not executable", files: map[string]string{"plugin.json": manifest, "bin/demo": "x"}, wantErr: "not executable"},
		{name: "bad manifest", files: map[string]string{"plugin.json": `{"name":"Demo","version":"1","protocol":1,"exec":["x"]}`}, wantErr: "name"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := writePkg(t, tt.files, tt.exec)
			out := t.TempDir()
			r, err := pack.Tarball(dir, out, "darwin/arm64")
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if r.Base != "demo-1.2.3-darwin-arm64.tar.gz" || len(r.SHA256) != 64 {
				t.Errorf("result = %+v", r)
			}
			got := entries(t, r.File)
			if len(got) != len(tt.want) {
				t.Errorf("entries = %v, want %v", got, tt.want)
			}
			for k, v := range tt.want {
				if got[k] != v {
					t.Errorf("%s mode = %o, want %o (all %v)", k, got[k], v, got)
				}
			}
			// Reproducible.
			r2, err := pack.Tarball(dir, t.TempDir(), "darwin/arm64")
			if err != nil || r2.SHA256 != r.SHA256 {
				t.Errorf("second pack sha = %s, %v; want %s", r2.SHA256, err, r.SHA256)
			}
		})
	}
}

func TestChecksumsAndEntry(t *testing.T) {
	out := t.TempDir()
	arm := writePkg(t, map[string]string{"plugin.json": manifest, "bin/demo": "arm"}, true)
	amd := writePkg(t, map[string]string{"plugin.json": manifest, "bin/demo": "amd"}, true)
	if err := os.WriteFile(filepath.Join(out, pack.ChecksumsFile), []byte("abc  other.tar.gz\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var rs []pack.Result
	for plat, dir := range map[string]string{"darwin/arm64": arm, "darwin/amd64": amd} {
		r, err := pack.Tarball(dir, out, plat)
		if err != nil {
			t.Fatal(err)
		}
		rs = append(rs, r)
	}
	if err := pack.WriteChecksums(out, rs...); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(filepath.Join(out, pack.ChecksumsFile))
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != 3 || !strings.HasSuffix(lines[0], "  demo-1.2.3-darwin-amd64.tar.gz") || lines[2] != "abc  other.tar.gz" {
		t.Errorf("checksums = %q", data)
	}
	e, err := pack.MakeEntry("o/demo", rs, func(r pack.Result) string { return pack.ReleaseURL("o/demo", r.Version, r.Base) })
	if err != nil {
		t.Fatal(err)
	}
	b, _ := pack.MarshalEntry(e)
	var back map[string]any
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatal(err)
	}
	arts := back["artifacts"].(map[string]any)
	if back["repo"] != "o/demo" || len(arts) != 2 ||
		arts["darwin/arm64"].(map[string]any)["url"] != "https://github.com/o/demo/releases/download/v1.2.3/demo-1.2.3-darwin-arm64.tar.gz" {
		t.Errorf("entry = %s", b)
	}
	perms := back["permissions"].(map[string]any)
	if !slices.Equal(toStrings(perms["commands"]), []string{"thread.send"}) {
		t.Errorf("permissions = %v", perms)
	}
	if _, err := pack.MakeEntry("o/demo", []pack.Result{rs[0], rs[0]}, func(pack.Result) string { return "" }); err == nil {
		t.Error("two tarballs for one platform should fail")
	}
}

func toStrings(v any) []string {
	var out []string
	for _, x := range v.([]any) {
		out = append(out, x.(string))
	}
	return out
}
