package gitops

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

// fakePNG is what the fake rasteriser returns for icns: a PNG signature and the path.
func fakePNG(icns string) []byte { return append(slices.Clone(pngMagic), icns...) }

// makeBundle makes app as a bundle: a stub Info.plist of "key=value" lines (what the
// fake plist reader understands) and empty files under Contents/Resources.
func makeBundle(t *testing.T, app string, plist map[string]string, resources ...string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(app, "Contents", "Resources"), 0o755); err != nil {
		t.Fatal(err)
	}
	if plist != nil {
		var b strings.Builder
		for _, k := range slices.Sorted(maps.Keys(plist)) {
			fmt.Fprintf(&b, "%s=%s\n", k, plist[k])
		}
		if err := os.WriteFile(filepath.Join(app, "Contents", "Info.plist"), []byte(b.String()), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, r := range resources {
		if err := os.WriteFile(filepath.Join(app, "Contents", "Resources", r), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// fakeIconEnv reads the stub plists and records what it rasterised; rasterise returns
// fakePNG, or out when set.
type fakeIconEnv struct {
	rasterised []string
	out        []byte
	err        error
}

func (f *fakeIconEnv) env(finder string) *iconEnv {
	return &iconEnv{
		finder: finder,
		plistString: func(_ context.Context, plist, key string) (string, error) {
			b, err := os.ReadFile(plist)
			if err != nil {
				return "", fmt.Errorf("read %s: %w", plist, err)
			}
			sc := bufio.NewScanner(bytes.NewReader(b))
			for sc.Scan() {
				if k, v, ok := strings.Cut(sc.Text(), "="); ok && k == key {
					return v, nil
				}
			}
			return "", fmt.Errorf("no value at key %s", key)
		},
		rasterise: func(_ context.Context, icns string, size int) ([]byte, error) {
			if size != AppIconSize {
				return nil, fmt.Errorf("size %d", size)
			}
			f.rasterised = append(f.rasterised, icns)
			if f.err != nil {
				return nil, f.err
			}
			if f.out != nil {
				return f.out, nil
			}
			return fakePNG(icns), nil
		},
	}
}

func TestReadAppIcon(t *testing.T) {
	tests := []struct {
		name      string
		plist     map[string]string // nil: no Info.plist
		resources []string
		out       []byte
		err       error
		want      string // the .icns rasterised, under Contents/Resources; "" for no icon
		noIcon    bool   // the error is errNoIcon
	}{
		{name: "a bare name gets .icns", plist: map[string]string{"CFBundleIconFile": "Code"}, resources: []string{"Code.icns"}, want: "Code.icns"},
		{name: "a name with .icns", plist: map[string]string{"CFBundleIconFile": "Finder.icns"}, resources: []string{"Finder.icns"}, want: "Finder.icns"},
		{name: "a name with another dot", plist: map[string]string{"CFBundleIconFile": "app.v2"}, resources: []string{"app.v2.icns"}, want: "app.v2.icns"},
		{name: "an asset catalog only app names no icon file", plist: map[string]string{"CFBundleIdentifier": "x"}},
		{name: "an empty name", plist: map[string]string{"CFBundleIconFile": ""}, noIcon: true},
		{name: "no Info.plist"},
		{name: "the icon file is missing", plist: map[string]string{"CFBundleIconFile": "Gone"}},
		{name: "a name outside Resources", plist: map[string]string{"CFBundleIconFile": "../Info.plist"}, noIcon: true},
		{name: "sips fails", plist: map[string]string{"CFBundleIconFile": "Code"}, resources: []string{"Code.icns"}, err: errors.New("sips: exit 1")},
		{name: "sips writes no PNG", plist: map[string]string{"CFBundleIconFile": "Code"}, resources: []string{"Code.icns"}, out: []byte("GIF89a"), noIcon: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			app := filepath.Join(t.TempDir(), "Some.app")
			makeBundle(t, app, tt.plist, tt.resources...)
			f := &fakeIconEnv{out: tt.out, err: tt.err}
			png, err := readAppIcon(context.Background(), *f.env(""), app)
			if tt.want == "" || tt.noIcon || tt.out != nil || tt.err != nil {
				if err == nil {
					t.Fatalf("icon = %q, want an error", png)
				}
				if tt.noIcon && !errors.Is(err, errNoIcon) {
					t.Errorf("err = %v, want errNoIcon", err)
				}
				if tt.err != nil && !errors.Is(err, tt.err) {
					t.Errorf("err = %v, want it to wrap %v", err, tt.err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			icns := filepath.Join(app, "Contents", "Resources", tt.want)
			if !bytes.Equal(png, fakePNG(icns)) || !slices.Equal(f.rasterised, []string{icns}) {
				t.Errorf("icon = %q, rasterised %v; want %s", png, f.rasterised, icns)
			}
		})
	}
}

func TestAppIcons(t *testing.T) {
	home := t.TempDir()
	finder := filepath.Join(home, "Finder.app")
	zed := filepath.Join(home, "Applications", "Zed.app")
	cursor := filepath.Join(home, "Applications", "Cursor.app")
	makeBundle(t, finder, map[string]string{"CFBundleIconFile": "Finder.icns"}, "Finder.icns")
	makeBundle(t, zed, map[string]string{"CFBundleIconFile": "Zed"}, "Zed.icns")
	makeBundle(t, cursor, map[string]string{"CFBundleIdentifier": "com.todesktop.230313mzl4w4u92"}) // no icon file
	f := &fakeIconEnv{}
	m := New(Options{Bus: bus.New()})
	t.Cleanup(func() { _ = m.Close() })
	m.opts.appEnv = fakeApps(home, []string{zed, cursor}, nil)
	m.opts.iconEnv = f.env(finder)
	ctx := context.Background()

	finderPNG := fakePNG(filepath.Join(finder, "Contents", "Resources", "Finder.icns"))
	zedPNG := fakePNG(filepath.Join(zed, "Contents", "Resources", "Zed.icns"))
	ids := []string{FinderBundleID, "dev.zed.Zed", "com.todesktop.230313mzl4w4u92", "com.example.unknown", "", FinderBundleID}
	want := map[string][]byte{FinderBundleID: finderPNG, "dev.zed.Zed": zedPNG}
	same := func(got map[string][]byte) bool { return maps.EqualFunc(got, want, bytes.Equal) }

	if got := m.AppIcons(ctx, ids); !same(got) {
		t.Fatalf("icons = %q, want %q", got, want)
	}
	if len(f.rasterised) != 2 {
		t.Errorf("rasterised %v, want Finder and Zed once each", f.rasterised)
	}
	// Cached, the misses too (Cursor has no icon file, so nothing more is read).
	if got := m.AppIcons(ctx, ids); !same(got) || len(f.rasterised) != 2 {
		t.Errorf("second call: icons %q, rasterised %v", got, f.rasterised)
	}
	// Finder alone does not need the editors.
	m2 := New(Options{Bus: bus.New()})
	t.Cleanup(func() { _ = m2.Close() })
	m2.opts.appEnv = &appEnv{isApp: func(string) bool { t.Error("Finder alone detected editors"); return false }}
	m2.opts.iconEnv = (&fakeIconEnv{}).env(finder)
	if got := m2.AppIcons(ctx, []string{FinderBundleID}); !bytes.Equal(got[FinderBundleID], finderPNG) || len(got) != 1 {
		t.Errorf("Finder alone = %q", got)
	}
	// Detection again (a settings change, a refresh) reads the icons again.
	m.RefreshEditorApps()
	m.AppIcons(ctx, ids)
	if len(f.rasterised) != 4 {
		t.Errorf("after RefreshEditorApps rasterised %v, want 4", f.rasterised)
	}
	m.EditorApps(ctx, true)
	m.AppIcons(ctx, []string{"dev.zed.Zed"})
	if len(f.rasterised) != 5 {
		t.Errorf("after a refresh rasterised %v, want 5", f.rasterised)
	}
	// A cancelled request still caches what it read.
	m.RefreshEditorApps()
	cctx, cancel := context.WithCancel(ctx)
	cancel()
	if got := m.AppIcons(cctx, ids); !same(got) {
		t.Errorf("cancelled request icons = %q", got)
	}
}
