package gitops

import (
	"cmp"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
)

// EditorApp is an editor installed as an app bundle: what "Open in <app>" offers and
// OpenOptions.App names.
type EditorApp struct {
	// Name is the display name ("VS Code", "GoLand").
	Name string
	// BundleID is the bundle's CFBundleIdentifier: what `open -b` takes.
	BundleID string
	// Path is the .app the detection found.
	Path string
}

// knownEditor is an editor the detection looks for: its display name, the bundle names
// it installs as (the current name first, then older ones), and its bundle id (used when
// the bundle's Info.plist cannot be read).
type knownEditor struct {
	name     string
	bundles  []string
	bundleID string
}

// knownEditors is every editor "Open in" can offer, in the order it lists them. Add a
// row to support another one.
var knownEditors = []knownEditor{
	{"VS Code", []string{"Visual Studio Code.app"}, "com.microsoft.VSCode"},
	{"VS Code Insiders", []string{"Visual Studio Code - Insiders.app"}, "com.microsoft.VSCodeInsiders"},
	{"Cursor", []string{"Cursor.app"}, "com.todesktop.230313mzl4w4u92"},
	{"Zed", []string{"Zed.app"}, "dev.zed.Zed"},
	{"Devin", []string{"Devin.app", "Windsurf.app"}, "com.exafunction.windsurf"},
	{"Sublime Text", []string{"Sublime Text.app"}, "com.sublimetext.4"},
	{"IntelliJ IDEA", []string{"IntelliJ IDEA.app", "IntelliJ IDEA Ultimate.app"}, "com.jetbrains.intellij"},
	{"IntelliJ IDEA CE", []string{"IntelliJ IDEA CE.app", "IntelliJ IDEA Community Edition.app"}, "com.jetbrains.intellij.ce"},
	{"GoLand", []string{"GoLand.app"}, "com.jetbrains.goland"},
	{"PyCharm", []string{"PyCharm.app", "PyCharm Professional Edition.app"}, "com.jetbrains.pycharm"},
	{"PyCharm CE", []string{"PyCharm CE.app", "PyCharm Community Edition.app"}, "com.jetbrains.pycharm.ce"},
	{"WebStorm", []string{"WebStorm.app"}, "com.jetbrains.WebStorm"},
	{"PhpStorm", []string{"PhpStorm.app"}, "com.jetbrains.PhpStorm"},
	{"RubyMine", []string{"RubyMine.app"}, "com.jetbrains.rubymine"},
	{"CLion", []string{"CLion.app"}, "com.jetbrains.CLion"},
	{"RustRover", []string{"RustRover.app"}, "com.jetbrains.rustrover"},
	{"Rider", []string{"Rider.app"}, "com.jetbrains.rider"},
	{"DataGrip", []string{"DataGrip.app"}, "com.jetbrains.datagrip"},
	{"Xcode", []string{"Xcode.app"}, "com.apple.dt.Xcode"},
}

// appDirs are where bundles are looked for, under the home directory when relative:
// the system and the user's Applications, and the folder older JetBrains Toolbox
// versions install into.
var appDirs = []string{"/Applications", "Applications", "Applications/JetBrains Toolbox"}

// appEnv is what app detection reads from the system; tests fake it.
type appEnv struct {
	home string
	// isApp reports whether path is a directory (a bundle).
	isApp func(path string) bool
	// bundleID reads a bundle's CFBundleIdentifier.
	bundleID func(ctx context.Context, app string) (string, error)
}

func systemAppEnv() appEnv {
	home, _ := os.UserHomeDir()
	return appEnv{
		home: home,
		isApp: func(p string) bool {
			fi, err := os.Stat(p)
			return err == nil && fi.IsDir()
		},
		bundleID: func(ctx context.Context, app string) (string, error) {
			return plutilString(ctx, filepath.Join(app, "Contents", "Info.plist"), "CFBundleIdentifier")
		},
	}
}

// detectEditorApps lists the known editors installed, in knownEditors order, the first
// bundle found for each (the system's Applications before the user's). A bundle id
// already listed (two names of one app) is not listed again.
func detectEditorApps(ctx context.Context, env appEnv) []EditorApp {
	var out []EditorApp
	for _, k := range knownEditors {
		path := ""
	find:
		for _, dir := range appDirs {
			if !filepath.IsAbs(dir) {
				if env.home == "" {
					continue
				}
				dir = filepath.Join(env.home, dir)
			}
			for _, b := range k.bundles {
				if p := filepath.Join(dir, b); env.isApp(p) {
					path = p
					break find
				}
			}
		}
		if path == "" {
			continue
		}
		id := k.bundleID
		if got, err := env.bundleID(ctx, path); err == nil && got != "" {
			id = got
		}
		if slices.ContainsFunc(out, func(a EditorApp) bool { return a.BundleID == id }) {
			continue
		}
		out = append(out, EditorApp{Name: k.name, BundleID: id, Path: path})
	}
	return out
}

// editorApps caches the detection: made on first use, again after Refresh.
type editorApps struct {
	mu    sync.Mutex
	done  bool
	apps  []EditorApp
	stale bool
}

// EditorApps implements Store: the installed editors "Open in" offers, detected on
// first use and cached until RefreshEditorApps (the daemon calls it on a settings
// change) or refresh. A refresh drops the cached icons too (AppIcons).
func (m *Manager) EditorApps(ctx context.Context, refresh bool) []EditorApp {
	if refresh {
		m.icons.clear()
	}
	m.apps.mu.Lock()
	defer m.apps.mu.Unlock()
	if !m.apps.done || m.apps.stale || refresh {
		env := systemAppEnv()
		if m.opts.appEnv != nil {
			env = *m.opts.appEnv
		}
		// Detection outlives the request: a cancelled one must not cache the registry's
		// fallback ids until the next settings change.
		m.apps.apps, m.apps.done, m.apps.stale = detectEditorApps(context.WithoutCancel(ctx), env), true, false
		m.log.Debug("editor apps detected", "count", len(m.apps.apps))
	}
	return slices.Clone(m.apps.apps)
}

// RefreshEditorApps makes the next EditorApps detect again and AppIcons read the icons
// again.
func (m *Manager) RefreshEditorApps() {
	m.apps.mu.Lock()
	m.apps.stale = true
	m.apps.mu.Unlock()
	m.icons.clear()
}

// editorApp finds bundleID among the detected editors.
func (m *Manager) editorApp(ctx context.Context, bundleID string) (EditorApp, error) {
	apps := m.EditorApps(ctx, false)
	if i := slices.IndexFunc(apps, func(a EditorApp) bool { return a.BundleID == bundleID }); i >= 0 {
		return apps[i], nil
	}
	// Installed since the last detection?
	apps = m.EditorApps(ctx, true)
	if i := slices.IndexFunc(apps, func(a EditorApp) bool { return a.BundleID == bundleID }); i >= 0 {
		return apps[i], nil
	}
	names := make([]string, len(apps))
	for i, a := range apps {
		names[i] = a.BundleID
	}
	return EditorApp{}, fmt.Errorf("%w: no installed editor has bundle id %q (installed: %s)", ErrInvalidArgument, bundleID, cmp.Or(strings.Join(names, ", "), "none"))
}
