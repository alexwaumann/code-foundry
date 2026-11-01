package gitops

import (
	"context"
	"errors"
	"path/filepath"
	"slices"
	"testing"
)

// fakeApps is an appEnv over a set of bundle paths; ids maps a bundle path to the id
// its Info.plist names (missing: unreadable).
func fakeApps(home string, bundles []string, ids map[string]string) *appEnv {
	return &appEnv{
		home:  home,
		isApp: func(p string) bool { return slices.Contains(bundles, p) },
		bundleID: func(_ context.Context, app string) (string, error) {
			if id, ok := ids[app]; ok {
				return id, nil
			}
			return "", errors.New("no Info.plist")
		},
	}
}

func TestDetectEditorApps(t *testing.T) {
	const home = "/Users/me"
	tests := []struct {
		name    string
		bundles []string
		ids     map[string]string
		want    []EditorApp
	}{
		{name: "nothing installed"},
		{name: "registry order, ids from the bundle, the registry's when unreadable",
			bundles: []string{"/Applications/Zed.app", "/Applications/Visual Studio Code.app", "/Applications/Xcode.app"},
			ids:     map[string]string{"/Applications/Zed.app": "dev.zed.Zed", "/Applications/Xcode.app": "com.apple.dt.Xcode"},
			want: []EditorApp{
				{Name: "VS Code", BundleID: "com.microsoft.VSCode", Path: "/Applications/Visual Studio Code.app"},
				{Name: "Zed", BundleID: "dev.zed.Zed", Path: "/Applications/Zed.app"},
				{Name: "Xcode", BundleID: "com.apple.dt.Xcode", Path: "/Applications/Xcode.app"},
			}},
		{name: "the user's Applications and JetBrains Toolbox's folder",
			bundles: []string{home + "/Applications/GoLand.app", home + "/Applications/JetBrains Toolbox/PyCharm Community Edition.app"},
			want: []EditorApp{
				{Name: "GoLand", BundleID: "com.jetbrains.goland", Path: home + "/Applications/GoLand.app"},
				{Name: "PyCharm CE", BundleID: "com.jetbrains.pycharm.ce", Path: home + "/Applications/JetBrains Toolbox/PyCharm Community Edition.app"},
			}},
		{name: "the system's copy wins over the user's",
			bundles: []string{home + "/Applications/Cursor.app", "/Applications/Cursor.app"},
			want:    []EditorApp{{Name: "Cursor", BundleID: "com.todesktop.230313mzl4w4u92", Path: "/Applications/Cursor.app"}}},
		{name: "Devin under its new name, its id from the plist",
			bundles: []string{"/Applications/Devin.app"},
			ids:     map[string]string{"/Applications/Devin.app": "com.cognition.devin"},
			want:    []EditorApp{{Name: "Devin", BundleID: "com.cognition.devin", Path: "/Applications/Devin.app"}}},
		{name: "Devin under its old name Windsurf, the registry's id",
			bundles: []string{"/Applications/Windsurf.app"},
			want:    []EditorApp{{Name: "Devin", BundleID: "com.exafunction.windsurf", Path: "/Applications/Windsurf.app"}}},
		{name: "one bundle id under two names is listed once",
			bundles: []string{"/Applications/IntelliJ IDEA.app", "/Applications/IntelliJ IDEA CE.app"},
			ids:     map[string]string{"/Applications/IntelliJ IDEA.app": "com.jetbrains.intellij", "/Applications/IntelliJ IDEA CE.app": "com.jetbrains.intellij"},
			want:    []EditorApp{{Name: "IntelliJ IDEA", BundleID: "com.jetbrains.intellij", Path: "/Applications/IntelliJ IDEA.app"}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := detectEditorApps(context.Background(), *fakeApps(home, tt.bundles, tt.ids))
			if !slices.Equal(got, tt.want) {
				t.Errorf("apps = %+v\nwant %+v", got, tt.want)
			}
		})
	}
}

func TestOpenEditorApp(t *testing.T) {
	fr := &fakeRunner{}
	w := newWorld(t, Options{Runner: fr, Editor: func() string { return "zed" }})
	bundles := []string{"/Applications/Zed.app"}
	env := fakeApps("/Users/me", bundles, nil)
	isApp := env.isApp
	scans := 0
	env.isApp = func(p string) bool { scans++; return isApp(p) || slices.Contains(bundles, p) }
	w.m.opts.appEnv = env
	ctx := context.Background()

	if apps := w.m.EditorApps(ctx, false); len(apps) != 1 || apps[0].BundleID != "dev.zed.Zed" {
		t.Fatalf("apps = %+v", apps)
	}
	// Cached until a refresh.
	n := scans
	w.m.EditorApps(ctx, false)
	if scans != n {
		t.Errorf("a second call scanned again")
	}
	bundles = append(bundles, "/Applications/Cursor.app")
	if apps := w.m.EditorApps(ctx, false); len(apps) != 1 {
		t.Errorf("cached apps = %+v", apps)
	}
	w.m.RefreshEditorApps()
	if apps := w.m.EditorApps(ctx, false); len(apps) != 2 {
		t.Errorf("apps after a refresh = %+v", apps)
	}

	wantOK(t, mustOp(t)(w.m.OpenEditor(ctx, OpenOptions{WorktreePath: w.a, App: "dev.zed.Zed"})), "opened a in Zed")
	if c := fr.called("open"); len(c) != 1 || !slices.Equal(c[0].Args, []string{"-b", "dev.zed.Zed", w.a}) {
		t.Errorf("open -b calls = %+v", c)
	}
	// A file opens with the app too (no line).
	w.m.opts.Root = filepath.Dir(w.a)
	readme := filepath.Join(w.a, "README")
	wantOK(t, mustOp(t)(w.m.OpenEditor(ctx, OpenOptions{WorktreePath: w.a, File: "README", Line: 4, App: "com.todesktop.230313mzl4w4u92"})), "opened README in Cursor")
	if c := fr.called("open"); len(c) != 2 || !slices.Equal(c[1].Args, []string{"-b", "com.todesktop.230313mzl4w4u92", readme}) {
		t.Errorf("open -b file calls = %+v", c)
	}
	// An app installed since the last detection is found; one that is not refuses.
	bundles = append(bundles, "/Applications/Xcode.app")
	wantOK(t, mustOp(t)(w.m.OpenEditor(ctx, OpenOptions{WorktreePath: w.a, App: "com.apple.dt.Xcode"})), "opened a in Xcode")
	if _, err := w.m.OpenEditor(ctx, OpenOptions{WorktreePath: w.a, App: "com.example.nope"}); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("unknown app err = %v", err)
	}
	if len(fr.called("zed")) != 0 {
		t.Errorf("the configured editor ran for an app open")
	}
}
