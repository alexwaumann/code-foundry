package plugin_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/internal/store/plugin/registry"
	"github.com/alexwaumann/code-foundry/internal/store/plugin/registry/registrytest"
	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/pack"
)

// regRig is a registry served by httptest (index.json and tarballs from one directory)
// plus a fake gh for GitHub releases, and a store reading both.
type regRig struct {
	*env
	srv    *httptest.Server
	served string // the directory the server serves
	src    string // where test packages are built
	gh     *registrytest.Gh
	// entries are index.json's plugins by name.
	entries map[string]pack.Entry
}

func newRegRig(t *testing.T) *regRig {
	t.Helper()
	g := &regRig{served: t.TempDir(), src: t.TempDir(), gh: registrytest.NewGh(), entries: map[string]pack.Entry{}}
	g.srv = httptest.NewServer(http.FileServer(http.Dir(g.served)))
	t.Cleanup(g.srv.Close)
	g.writeIndex()
	g.env = newEnv(t, func(o *plugin.Options) {
		o.Registry = registry.NewClient(registry.Options{
			CacheDir: filepath.Join(o.Dir, plugin.RegistryCacheDir),
			Fetcher:  registry.Fetcher{Gh: g.gh, HTTP: g.srv.Client()},
			Log:      slog.New(slog.DiscardHandler),
		})
		locs, err := registry.ParseList(g.srv.URL + "/index.json")
		if err != nil {
			t.Fatal(err)
		}
		o.Registry.SetLocations(locs)
	})
	return g
}

// build makes a package of name at version (the "ok" test plugin) with perms and packs
// it into the served directory.
func (g *regRig) build(name, version string, perms pluginsdk.Permissions) pack.Result {
	g.t.Helper()
	mf := testManifest(name)
	mf.Version, mf.Permissions = version, perms
	dir := g.install(filepath.Join(g.src, version), name, "ok", mf)
	r, err := pack.Tarball(dir, g.served, registry.Platform())
	if err != nil {
		g.t.Fatal(err)
	}
	return r
}

// publish lists r in the index, with the entry's permissions perms.
func (g *regRig) publish(r pack.Result, perms pluginsdk.Permissions) {
	g.t.Helper()
	e, err := pack.MakeEntry("o/"+r.Name, []pack.Result{r}, func(r pack.Result) string { return g.srv.URL + "/" + r.Base })
	if err != nil {
		g.t.Fatal(err)
	}
	e.Permissions = perms
	g.entries[r.Name] = e
	g.writeIndex()
}

func (g *regRig) writeIndex() {
	list := []pack.Entry{}
	for _, e := range g.entries {
		list = append(list, e)
	}
	b, _ := json.Marshal(map[string]any{"schema": 1, "plugins": list})
	if err := os.WriteFile(filepath.Join(g.served, "index.json"), b, 0o644); err != nil {
		panic(err)
	}
}

var basePerms = pluginsdk.Permissions{Commands: []string{"thread.send"}, Secrets: true}

func TestRegistryInstallUpdateUninstall(t *testing.T) {
	g := newRegRig(t)
	ctx := context.Background()
	g.publish(g.build("hello", "0.1.0", basePerms), basePerms)
	m := g.start()
	sub := bus.Subscribe[plugin.Event](m.Bus(), 256)
	defer sub.Close()

	// Browse.
	br, err := m.Browse(ctx, false)
	if err != nil || len(br.Entries) != 1 || br.Entries[0].Name != "hello" || br.Entries[0].Installed != nil ||
		len(br.Registries) != 1 || br.Registries[0].Error != "" {
		t.Fatalf("browse = %+v, %v", br, err)
	}

	// Install: disabled pending consent, recorded, progress on the bus.
	res, err := m.Install(ctx, plugin.InstallRequest{Ref: "hello"})
	if err != nil || !res.Changed || res.Version != "0.1.0" || res.Kind != plugin.KindRegistry || res.Previous != "" {
		t.Fatalf("install = %+v, %v", res, err)
	}
	p := res.Plugin
	if p.Enabled || !p.NeedsConsent || p.State != plugin.StateDisabled || p.Installed == nil ||
		p.Installed.Source != g.srv.URL+"/index.json" || p.Installed.Version != "0.1.0" || len(p.Installed.SHA256) != 64 {
		t.Fatalf("installed plugin = %+v (record %+v)", p, p.Installed)
	}
	if fi, err := os.Lstat(filepath.Join(g.opts.Dir, "hello")); err != nil || !fi.IsDir() {
		t.Fatalf("package dir: %v %v", fi, err)
	}
	if phases := progressPhases(sub, "hello"); phases != "resolving downloading verifying extracting installing done" {
		t.Errorf("progress = %s", phases)
	}
	// Installing the same version again does nothing.
	if res, err := m.Install(ctx, plugin.InstallRequest{Ref: "hello@0.1.0"}); err != nil || res.Changed {
		t.Errorf("reinstall = %+v, %v", res, err)
	}

	// Enable with consent; the plugin keeps data in its data dir.
	if _, err := m.Enable(ctx, "hello", true); err != nil {
		t.Fatal(err)
	}
	g.waitState("hello", plugin.StateRunning)
	if r, err := g.invoke("plugin.hello.remember", map[string]string{"word": "swordfish"}, command.Context{}); err != nil || r.Message != "remembered" {
		t.Fatalf("remember = %+v, %v", r, err)
	}
	dataFile := filepath.Join(g.opts.DataDir, "hello", "state")
	if err := os.WriteFile(dataFile, []byte("kept"), 0o600); err != nil {
		t.Fatal(err)
	}

	// 0.1.1 appears: the check offers it, the snapshot carries it, nothing installs.
	g.publish(g.build("hello", "0.1.1", basePerms), basePerms)
	ups, err := m.CheckUpdates(ctx, true)
	if err != nil || len(ups) != 1 || ups[0].Version != "0.1.1" || ups[0].Current != "0.1.0" {
		t.Fatalf("check = %+v, %v", ups, err)
	}
	if p, _ := m.Snapshot().Plugin("hello"); p.Update == nil || p.Update.Version != "0.1.1" || p.Manifest.Version != "0.1.0" {
		t.Fatalf("snapshot update = %+v", p.Update)
	}
	if ups, err := m.Update(ctx, "hello", true, false); err != nil || len(ups) != 1 || ups[0].Updated {
		t.Fatalf("update --check = %+v, %v", ups, err)
	}

	// Update: replaced, still enabled and running, data and secrets kept.
	ups, err = m.Update(ctx, "hello", false, false)
	if err != nil || len(ups) != 1 || !ups[0].Updated || ups[0].Error != "" || ups[0].Disabled != "" {
		t.Fatalf("update = %+v, %v", ups, err)
	}
	p = g.wait("hello", "0.1.1 running", func(p plugin.Plugin) bool {
		return p.Manifest.Version == "0.1.1" && p.State == plugin.StateRunning
	})
	if !p.Enabled || p.Update != nil || p.Installed.Version != "0.1.1" {
		t.Fatalf("after update: %+v", p)
	}
	if b, err := os.ReadFile(dataFile); err != nil || string(b) != "kept" {
		t.Errorf("data file after update: %q, %v", b, err)
	}
	if r, err := g.invoke("plugin.hello.recall", nil, command.Context{}); err != nil || r.Message != "swordfish" {
		t.Errorf("recall after update = %+v, %v", r, err)
	}
	if !strings.Contains(g.logText("hello"), "updated 0.1.0 → 0.1.1 from "+g.srv.URL) {
		t.Errorf("log:\n%s", g.logText("hello"))
	}

	// 0.1.2 asks for more: updated, but disabled until the user consents again.
	more := basePerms
	more.ThreadStatus = true
	g.publish(g.build("hello", "0.1.2", more), more)
	ups, err = m.Update(ctx, "", false, true)
	if err != nil || len(ups) != 1 || !ups[0].Updated || !strings.Contains(ups[0].Disabled, "permissions changed") {
		t.Fatalf("update with more permissions = %+v, %v", ups, err)
	}
	p = g.waitState("hello", plugin.StateDisabled)
	if p.Enabled || !p.NeedsConsent || p.Manifest.Version != "0.1.2" {
		t.Fatalf("after growing update: %+v", p)
	}

	// A tampered tarball is refused and the installed package stays.
	r3 := g.build("hello", "0.1.3", more)
	g.publish(r3, more)
	e := g.entries["hello"]
	a := e.Artifacts[registry.Platform()]
	a.SHA256 = strings.Repeat("0", 64)
	e.Artifacts[registry.Platform()] = a
	g.entries["hello"] = e
	g.writeIndex()
	sub2 := bus.Subscribe[plugin.Event](m.Bus(), 256)
	defer sub2.Close()
	if _, err := m.Install(ctx, plugin.InstallRequest{Ref: "hello", Refresh: true}); !errors.Is(err, plugin.ErrFailedPrecondition) || !strings.Contains(err.Error(), "sha256 mismatch") {
		t.Fatalf("tampered install err = %v", err)
	}
	if p, _ := m.Snapshot().Plugin("hello"); p.Manifest.Version != "0.1.2" {
		t.Fatalf("version after refused install = %s", p.Manifest.Version)
	}
	if left, _ := os.ReadDir(filepath.Join(g.opts.Dir, plugin.StagingDir)); len(left) != 0 {
		t.Errorf("staging not cleaned: %v", left)
	}
	if phases := progressPhases(sub2, "hello"); phases != "resolving downloading verifying failed" {
		t.Errorf("failed install progress = %s", phases)
	}

	// Uninstall --purge: package, data, secrets and consent gone.
	ur, err := m.Uninstall(ctx, "hello", true)
	if err != nil || ur.Removed == "" || len(ur.Purged) < 3 {
		t.Fatalf("uninstall = %+v, %v", ur, err)
	}
	if _, ok := m.Snapshot().Plugin("hello"); ok {
		t.Fatal("still listed after uninstall")
	}
	for _, p := range []string{filepath.Join(g.opts.Dir, "hello"), filepath.Join(g.opts.DataDir, "hello")} {
		if _, err := os.Stat(p); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s still there: %v", p, err)
		}
	}
	if v, ok, _ := g.secrets.Get(ctx, "hello", "word"); ok {
		t.Errorf("secret survived the purge: %q", v)
	}
	if list, _ := m.Secrets(ctx, "hello"); len(list) != 0 {
		t.Errorf("secret names survived the purge: %v", list)
	}
	if _, err := m.Uninstall(ctx, "hello", true); !errors.Is(err, plugin.ErrNotFound) {
		t.Errorf("second uninstall err = %v", err)
	}
	// Reinstalled, it needs consent again: the purge forgot it.
	g.publish(g.build("hello", "0.1.4", basePerms), basePerms)
	res, err = m.Install(ctx, plugin.InstallRequest{Ref: "hello", Enable: true, Refresh: true})
	if err != nil || !res.NeedsConsent || res.Plugin.Enabled || !strings.Contains(res.Consent, "Enable Test hello 0.1.4?") {
		t.Fatalf("reinstall after purge = %+v, %v", res, err)
	}
	// Uninstall without purge keeps the consent: the next install enables without asking.
	if _, err := m.Enable(ctx, "hello", true); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Uninstall(ctx, "hello", false); err != nil {
		t.Fatal(err)
	}
	res, err = m.Install(ctx, plugin.InstallRequest{Ref: "hello", Enable: true})
	if err != nil || res.NeedsConsent || !res.Plugin.Enabled {
		t.Fatalf("reinstall after uninstall = %+v, %v", res, err)
	}
	g.waitState("hello", plugin.StateRunning)
}

// progressPhases reads sub until an install of name ends (done or failed) and returns
// the phases seen.
func progressPhases(sub *bus.Subscription[plugin.Event], name string) string {
	var out []string
	deadline := time.After(5 * time.Second)
	for {
		select {
		case ev := <-sub.C():
			p, ok := ev.(plugin.InstallProgress)
			if !ok || (p.Name != name && p.Name != "") || p.Bytes != 0 {
				continue
			}
			out = append(out, p.Phase.String())
			if p.Phase == plugin.InstallDone || p.Phase == plugin.InstallFailed {
				return strings.Join(out, " ")
			}
		case <-deadline:
			return strings.Join(out, " ") + " (timed out)"
		}
	}
}

func TestInstallRefusals(t *testing.T) {
	g := newRegRig(t)
	ctx := context.Background()
	// The manifest asks for more than the entry lists.
	r := g.build("greedy", "1.0.0", pluginsdk.Permissions{Commands: []string{"thread.send"}, API: true})
	g.publish(r, pluginsdk.Permissions{Commands: []string{"thread.send"}})
	// The tarball's manifest is another plugin.
	other := g.build("imposter", "1.0.0", basePerms)
	g.publish(other, basePerms)
	e := g.entries["imposter"]
	e.Name = "victim"
	g.entries["victim"] = e
	g.writeIndex()
	m := g.start()

	tests := []struct {
		ref     string
		wantErr error
		msg     string
	}{
		{ref: "greedy", wantErr: plugin.ErrFailedPrecondition, msg: "asks for permissions its registry entry does not list"},
		{ref: "victim", wantErr: plugin.ErrFailedPrecondition, msg: `plugin.json names "imposter", not "victim"`},
		{ref: "nope", wantErr: plugin.ErrNotFound, msg: `no plugin "nope" in the registries`},
		{ref: "Bad Name", wantErr: plugin.ErrInvalidArgument, msg: "not a plugin name"},
		{ref: "./relative", wantErr: plugin.ErrInvalidArgument, msg: "relative path"},
		{ref: "o/r@latest", wantErr: plugin.ErrInvalidArgument, msg: "vX.Y.Z"},
		{ref: "greedy@2.0.0", wantErr: plugin.ErrNotFound, msg: "has no release v2.0.0"},
	}
	for _, tt := range tests {
		t.Run(tt.ref, func(t *testing.T) {
			_, err := m.Install(ctx, plugin.InstallRequest{Ref: tt.ref})
			if !errors.Is(err, tt.wantErr) || !strings.Contains(err.Error(), tt.msg) {
				t.Fatalf("err = %v, want %v %q", err, tt.wantErr, tt.msg)
			}
			if _, ok := m.Snapshot().Plugin(strings.Split(tt.ref, "@")[0]); ok {
				t.Error("installed anyway")
			}
		})
	}
	// No registry configured (the setting's default): a name has nowhere to be looked up.
	m.SetRegistries(nil)
	_, err := m.Install(ctx, plugin.InstallRequest{Ref: "greedy"})
	if !errors.Is(err, plugin.ErrNotFound) || !strings.Contains(err.Error(), `no plugin registry is configured to look up "greedy"`) {
		t.Fatalf("no registry: err = %v", err)
	}
}

func TestInstallFromGitHubRelease(t *testing.T) {
	g := newRegRig(t)
	ctx := context.Background()
	r := g.build("gh-plugin", "0.2.0", basePerms)
	rel := func(tag string, assets ...string) string {
		var parts []string
		for _, a := range assets {
			parts = append(parts, fmt.Sprintf(`{"name":%q,"url":"https://github.com/o/ghp/releases/download/%s/%s"}`, a, tag, a))
		}
		return fmt.Sprintf(`{"tagName":%q,"assets":[%s]}`, tag, strings.Join(parts, ","))
	}
	if err := pack.WriteChecksums(g.served, r); err != nil {
		t.Fatal(err)
	}
	g.gh.Releases["o/ghp@"] = rel("v0.2.0", r.Base, "checksums.txt")
	g.gh.Releases["o/ghp@v0.2.0"] = rel("v0.2.0", r.Base)
	g.gh.Assets["o/ghp/v0.2.0/"+r.Base] = r.File
	g.gh.Assets["o/ghp/v0.2.0/checksums.txt"] = filepath.Join(g.served, "checksums.txt")
	m := g.start()

	res, err := m.Install(ctx, plugin.InstallRequest{Ref: "o/ghp", Enable: true, Consent: true})
	if err != nil || res.Kind != plugin.KindGitHub || res.Source != "o/ghp" || res.Version != "0.2.0" || len(res.Warnings) != 0 {
		t.Fatalf("install = %+v, %v", res, err)
	}
	p := g.waitState("gh-plugin", plugin.StateRunning)
	if p.Installed == nil || p.Installed.Kind != plugin.KindGitHub || len(p.Installed.SHA256) != 64 {
		t.Fatalf("record = %+v", p.Installed)
	}
	// Without a checksums file: installed, with a warning, and recorded as unverified.
	res, err = m.Install(ctx, plugin.InstallRequest{Ref: "o/ghp@v0.2.0", Force: true})
	if err != nil || len(res.Warnings) != 1 || !strings.Contains(res.Warnings[0], "not verified") {
		t.Fatalf("unverified install = %+v, %v", res, err)
	}
	if p, _ := m.Snapshot().Plugin("gh-plugin"); p.Installed.SHA256 != "" || !p.Enabled {
		t.Errorf("after reinstall: %+v (record %+v)", p, p.Installed)
	}
	// A registry entry of another repository with the same name is no update for it.
	g.publish(g.build("gh-plugin", "0.3.0", basePerms), basePerms) // repo o/gh-plugin
	if ups, err := m.CheckUpdates(ctx, true); err != nil || len(ups) != 0 {
		t.Errorf("updates = %+v, %v", ups, err)
	}

	// Its own repository's newer release is its update: one `gh release view` per check.
	r4 := g.build("gh-plugin", "0.4.0", basePerms)
	g.gh.Releases["o/ghp@"] = rel("v0.4.0", r4.Base)
	g.gh.Releases["o/ghp@v0.4.0"] = rel("v0.4.0", r4.Base)
	g.gh.Assets["o/ghp/v0.4.0/"+r4.Base] = r4.File
	views := func() int {
		n := 0
		for _, c := range g.gh.Calls() {
			if strings.Join(c, " ") == "release view -R o/ghp --json tagName" {
				n++
			}
		}
		return n
	}
	before := views()
	ups, err := m.CheckUpdates(ctx, false)
	want := plugin.PluginUpdate{Name: "gh-plugin", Current: "0.2.0", Version: "0.4.0", Registry: "https://github.com/o/ghp", Ref: "o/ghp@v0.4.0"}
	if err != nil || len(ups) != 1 || ups[0] != want {
		t.Fatalf("updates = %+v, %v; want %+v", ups, err, want)
	}
	if n := views() - before; n != 1 {
		t.Errorf("%d release views in one check, want 1", n)
	}
	if p, _ := m.Snapshot().Plugin("gh-plugin"); p.Update == nil || p.Update.Version != "0.4.0" {
		t.Errorf("snapshot offer %+v", p.Update)
	}
	done, err := m.Update(ctx, "gh-plugin", false, false)
	if err != nil || len(done) != 1 || !done[0].Updated || done[0].Version != "0.4.0" {
		t.Fatalf("update = %+v, %v", done, err)
	}
	if p, _ := m.Snapshot().Plugin("gh-plugin"); p.Manifest.Version != "0.4.0" || p.Installed.Source != "o/ghp" || p.Update != nil {
		t.Errorf("after the update: %s from %+v, offer %+v", p.Manifest.Version, p.Installed, p.Update)
	}
}

func TestInstallLinksAndDevConflicts(t *testing.T) {
	g := newRegRig(t)
	ctx := context.Background()
	g.publish(g.build("linked", "1.0.0", basePerms), basePerms)
	m := g.start()
	src := g.install(t.TempDir(), "linked", "ok", testManifest("linked"))

	// install <folder>: a dev link, disabled until enabled.
	res, err := m.Install(ctx, plugin.InstallRequest{Ref: src})
	if err != nil || res.Kind != plugin.KindPath || res.Plugin.Enabled || !res.Plugin.Dev || res.Plugin.DevPath == "" {
		t.Fatalf("link install = %+v, %v", res, err)
	}
	// The registry's package does not replace a dev link without --force.
	if _, err := m.Install(ctx, plugin.InstallRequest{Ref: "linked"}); !errors.Is(err, plugin.ErrFailedPrecondition) || !strings.Contains(err.Error(), "is a dev link") {
		t.Fatalf("install over a link err = %v", err)
	}
	res, err = m.Install(ctx, plugin.InstallRequest{Ref: "linked", Force: true, Enable: true, Consent: true})
	if err != nil || res.Plugin.Dev || res.Kind != plugin.KindRegistry {
		t.Fatalf("forced install = %+v, %v", res, err)
	}
	g.waitState("linked", plugin.StateRunning)
	if _, err := os.Stat(filepath.Join(src, "plugin.json")); err != nil {
		t.Fatalf("the author's folder was touched: %v", err)
	}
	// A dev plugin is not updated; a folder does not replace a package without --force.
	if _, err := m.Install(ctx, plugin.InstallRequest{Ref: src}); !errors.Is(err, plugin.ErrFailedPrecondition) {
		t.Fatalf("link over a package err = %v", err)
	}
	if _, err := m.Install(ctx, plugin.InstallRequest{Ref: src, Force: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Update(ctx, "linked", false, false); !errors.Is(err, plugin.ErrFailedPrecondition) || !strings.Contains(err.Error(), "dev plugin") {
		t.Fatalf("update of a dev plugin err = %v", err)
	}
	// Uninstalling a dev plugin removes the link only.
	if _, err := m.Uninstall(ctx, "linked", true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(src, "plugin.json")); err != nil {
		t.Fatalf("uninstall touched the author's folder: %v", err)
	}
}

func TestRegistriesSettingAndCachedOffers(t *testing.T) {
	g := newRegRig(t)
	ctx := context.Background()
	g.publish(g.build("hello", "0.1.0", basePerms), basePerms)
	m := g.start()
	if _, err := m.Install(ctx, plugin.InstallRequest{Ref: "hello"}); err != nil {
		t.Fatal(err)
	}
	g.publish(g.build("hello", "0.2.0", basePerms), basePerms)
	if _, err := m.Browse(ctx, true); err != nil {
		t.Fatal(err)
	}
	if p, _ := m.Snapshot().Plugin("hello"); p.Update == nil || p.Update.Version != "0.2.0" {
		t.Fatalf("offer = %+v", p.Update)
	}
	// No registries: no offers (from the cache, no network).
	m.SetRegistries(nil)
	if p, _ := m.Snapshot().Plugin("hello"); p.Update != nil {
		t.Fatalf("offer without registries = %+v", p.Update)
	}
	locs, _ := registry.ParseList(g.srv.URL + "/index.json")
	g.srv.Close() // the cache must do
	m.SetRegistries(locs)
	if p, _ := m.Snapshot().Plugin("hello"); p.Update == nil {
		t.Fatal("offer from the cache missing")
	}
	// A restarted store knows the offer before any fetch.
	_ = m.Close()
	m2 := g.start()
	if p, _ := m2.Snapshot().Plugin("hello"); p.Update == nil || p.Installed == nil || p.Installed.Version != "0.1.0" {
		t.Fatalf("after restart: update %+v, installed %+v", p.Update, p.Installed)
	}
}
