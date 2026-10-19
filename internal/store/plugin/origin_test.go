package plugin_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/internal/store/plugin/registry"
	"github.com/alexwaumann/code-foundry/pluginsdk/pack"
)

// ghRelease serves r as the latest release of repo (with a checksums file) on the rig's
// fake gh, also by its tag.
func (g *regRig) ghRelease(repo string, r pack.Result) {
	g.t.Helper()
	dir := g.t.TempDir()
	if err := pack.WriteChecksums(dir, r); err != nil {
		g.t.Fatal(err)
	}
	tag := "v" + r.Version
	var assets []string
	for _, a := range []string{r.Base, "checksums.txt"} {
		assets = append(assets, fmt.Sprintf(`{"name":%q,"url":"https://github.com/%s/releases/download/%s/%s"}`, a, repo, tag, a))
	}
	g.gh.Releases[repo+"@"] = fmt.Sprintf(`{"tagName":%q,"assets":[%s]}`, tag, strings.Join(assets, ","))
	g.gh.Releases[repo+"@"+tag] = g.gh.Releases[repo+"@"]
	g.gh.Assets[repo+"/"+tag+"/"+r.Base] = r.File
	g.gh.Assets[repo+"/"+tag+"/checksums.txt"] = filepath.Join(dir, "checksums.txt")
}

// enabledWithSecret installs hello from the registry, enables it with consent, and has
// it store a secret and a data file.
func (g *regRig) enabledWithSecret(ctx context.Context, m *plugin.Manager) {
	g.t.Helper()
	if _, err := m.Install(ctx, plugin.InstallRequest{Ref: "hello", Enable: true, Consent: true}); err != nil {
		g.t.Fatal(err)
	}
	g.waitState("hello", plugin.StateRunning)
	if r, err := g.invoke("plugin.hello.remember", map[string]string{"word": "swordfish"}, command.Context{}); err != nil || r.Message != "remembered" {
		g.t.Fatalf("remember = %+v, %v", r, err)
	}
	if err := os.WriteFile(filepath.Join(g.opts.DataDir, "hello", "state"), []byte("kept"), 0o600); err != nil {
		g.t.Fatal(err)
	}
}

func (g *regRig) assertSecretKept(ctx context.Context, m *plugin.Manager) {
	g.t.Helper()
	if v, ok, _ := g.secrets.Get(ctx, "hello", "word"); !ok || v != "swordfish" {
		g.t.Fatalf("the Keychain item went: %q %v", v, ok)
	}
	if list, _ := m.Secrets(ctx, "hello"); len(list) != 1 {
		g.t.Fatalf("secret names: %+v", list)
	}
	if _, err := os.Stat(filepath.Join(g.opts.DataDir, "hello", "state")); err != nil {
		g.t.Fatalf("data: %v", err)
	}
}

func (g *regRig) assertPurged(ctx context.Context, m *plugin.Manager) {
	g.t.Helper()
	if v, ok, _ := g.secrets.Get(ctx, "hello", "word"); ok {
		g.t.Errorf("the Keychain item survived the takeover: %q", v)
	}
	if list, _ := m.Secrets(ctx, "hello"); len(list) != 0 {
		g.t.Errorf("secret names survived the takeover: %+v", list)
	}
	if _, err := os.Stat(filepath.Join(g.opts.DataDir, "hello", "state")); !errors.Is(err, os.ErrNotExist) {
		g.t.Errorf("data survived the takeover: %v", err)
	}
}

// TestTakeoverByAGitHubRelease: a release of another repository whose plugin is also
// called hello does not get the installed hello's consent, secrets and data. Without
// --force it is refused; with it they are deleted and the new package asks for consent.
func TestTakeoverByAGitHubRelease(t *testing.T) {
	g := newRegRig(t)
	ctx := context.Background()
	g.publish(g.build("hello", "0.1.0", basePerms), basePerms)
	g.ghRelease("evil/hello", g.build("hello", "0.9.0", basePerms))
	m := g.start()
	g.enabledWithSecret(ctx, m)

	_, err := m.Install(ctx, plugin.InstallRequest{Ref: "evil/hello", Enable: true, Consent: true})
	if !errors.Is(err, plugin.ErrFailedPrecondition) || !strings.Contains(err.Error(), "came from the registry "+g.srv.URL) ||
		!strings.Contains(err.Error(), "the releases of evil/hello") || !strings.Contains(err.Error(), "1 secret(s)") ||
		!strings.Contains(err.Error(), "--force") {
		t.Fatalf("takeover without --force: %v", err)
	}
	if p, _ := m.Snapshot().Plugin("hello"); p.Manifest.Version != "0.1.0" || !p.Enabled {
		t.Fatalf("after the refusal: %+v", p)
	}
	g.assertSecretKept(ctx, m)

	res, err := m.Install(ctx, plugin.InstallRequest{Ref: "evil/hello", Force: true, Enable: true, Consent: true})
	if err != nil || !res.Changed || res.Version != "0.9.0" || !res.NeedsConsent || res.Plugin.Enabled ||
		len(res.Warnings) != 1 || !strings.Contains(res.Warnings[0], "replaced plugin hello from the registry") {
		t.Fatalf("forced takeover = %+v, %v", res, err)
	}
	g.assertPurged(ctx, m)
	if !strings.Contains(g.logText("hello"), "taken over by the releases of evil/hello: deleted") {
		t.Errorf("log:\n%s", g.logText("hello"))
	}
	// The new package starts empty once consented to.
	if _, err := m.Enable(ctx, "hello", true); err != nil {
		t.Fatal(err)
	}
	g.waitState("hello", plugin.StateRunning)
	if r, _ := g.invoke("plugin.hello.recall", nil, command.Context{}); r.Message != "nothing" {
		t.Errorf("recall after the takeover = %q", r.Message)
	}
	// Its own source again is no takeover.
	if _, err := m.Install(ctx, plugin.InstallRequest{Ref: "evil/hello", Force: true}); err != nil {
		t.Fatalf("reinstall from the same source: %v", err)
	}
}

// TestTakeoverAfterUninstall: an uninstall without --purge keeps the consent, secrets
// and data for a reinstall from the same source, not for a package from another.
func TestTakeoverAfterUninstall(t *testing.T) {
	g := newRegRig(t)
	ctx := context.Background()
	g.publish(g.build("hello", "0.1.0", basePerms), basePerms)
	g.ghRelease("evil/hello", g.build("hello", "0.9.0", basePerms))
	m := g.start()
	g.enabledWithSecret(ctx, m)
	if _, err := m.Uninstall(ctx, "hello", false); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Install(ctx, plugin.InstallRequest{Ref: "evil/hello"}); !errors.Is(err, plugin.ErrFailedPrecondition) {
		t.Fatalf("install of another source after uninstall: %v", err)
	}
	if _, ok := m.Snapshot().Plugin("hello"); ok {
		t.Fatal("installed anyway")
	}
	g.assertSecretKept(ctx, m)
	res, err := m.Install(ctx, plugin.InstallRequest{Ref: "hello", Enable: true})
	if err != nil || res.NeedsConsent || !res.Plugin.Enabled {
		t.Fatalf("reinstall from the same registry = %+v, %v", res, err)
	}
	g.waitState("hello", plugin.StateRunning)
	if r, _ := g.invoke("plugin.hello.recall", nil, command.Context{}); r.Message != "swordfish" {
		t.Errorf("recall after reinstall = %q", r.Message)
	}
}

// TestTakeoverByADevLink: plugin dev of another folder with the same plugin name.
func TestTakeoverByADevLink(t *testing.T) {
	g := newRegRig(t)
	ctx := context.Background()
	m := g.start()
	srcA := g.install(t.TempDir(), "hello", "ok", testManifest("hello"))
	srcB := g.install(t.TempDir(), "hello", "ok", testManifest("hello"))
	if _, err := m.Dev(ctx, srcA, true, false, false); err != nil {
		t.Fatal(err)
	}
	g.waitState("hello", plugin.StateRunning)
	if r, _ := g.invoke("plugin.hello.remember", map[string]string{"word": "swordfish"}, command.Context{}); r.Message != "remembered" {
		t.Fatalf("remember = %q", r.Message)
	}
	// Linking the same folder again is no takeover.
	if res, err := m.Dev(ctx, srcA, false, true, false); err != nil || res.NeedsConsent {
		t.Fatalf("same folder dry run = %+v, %v", res, err)
	}
	realB, _ := filepath.EvalSymlinks(srcB)
	if _, err := m.Dev(ctx, srcB, true, false, false); !errors.Is(err, plugin.ErrFailedPrecondition) || !strings.Contains(err.Error(), "the folder "+realB) {
		t.Fatalf("another folder without --force: %v", err)
	}
	if v, ok, _ := g.secrets.Get(ctx, "hello", "word"); !ok || v != "swordfish" {
		t.Fatal("the refusal deleted the secret")
	}
	// The dry run (the CLI's confirm) asks for consent and says what goes.
	res, err := m.Dev(ctx, srcB, false, true, true)
	if err != nil || !res.NeedsConsent || !strings.Contains(res.Consent, "It replaces the plugin hello from the folder") ||
		!strings.Contains(res.Consent, "1 secret(s)") {
		t.Fatalf("forced dry run = %+v, %v", res, err)
	}
	if v, ok, _ := g.secrets.Get(ctx, "hello", "word"); !ok || v != "swordfish" {
		t.Fatal("the dry run deleted the secret")
	}
	if _, err := m.Dev(ctx, srcB, true, false, true); err != nil {
		t.Fatal(err)
	}
	p := g.waitState("hello", plugin.StateRunning)
	if p.DevPath != realB {
		t.Fatalf("linked to %s", p.DevPath)
	}
	if r, _ := g.invoke("plugin.hello.recall", nil, command.Context{}); r.Message != "nothing" {
		t.Errorf("recall after the takeover = %q", r.Message)
	}
	if _, ok, _ := g.secrets.Get(ctx, "hello", "word"); ok {
		t.Error("the old link's Keychain item survived")
	}
}

// TestNoUpdateFromAnotherRegistry: a registry listed first that also has a hello does
// not offer (or install) an update of the hello installed from the other registry.
func TestNoUpdateFromAnotherRegistry(t *testing.T) {
	g := newRegRig(t)
	ctx := context.Background()
	g.publish(g.build("hello", "0.1.0", basePerms), basePerms)
	m := g.start()
	if _, err := m.Install(ctx, plugin.InstallRequest{Ref: "hello"}); err != nil {
		t.Fatal(err)
	}
	// index2.json lists another hello, newer, from another repository.
	r := g.build("hello", "0.5.0", basePerms)
	e, err := pack.MakeEntry("evil/hello", []pack.Result{r}, func(r pack.Result) string { return g.srv.URL + "/" + r.Base })
	if err != nil {
		t.Fatal(err)
	}
	e.Permissions = basePerms
	b, _ := json.Marshal(map[string]any{"schema": 1, "plugins": []pack.Entry{e}})
	if err := os.WriteFile(filepath.Join(g.served, "index2.json"), b, 0o644); err != nil {
		t.Fatal(err)
	}
	locs, err := registry.ParseList(g.srv.URL + "/index2.json," + g.srv.URL + "/index.json")
	if err != nil {
		t.Fatal(err)
	}
	m.SetRegistries(locs)
	// Browse says where hello came from instead of offering the other registry's.
	br, err := m.Browse(ctx, false)
	if err != nil || len(br.Entries) != 1 {
		t.Fatalf("browse = %+v, %v", br, err)
	}
	if e := br.Entries[0]; e.Registry != g.srv.URL+"/index2.json" || e.Relation != plugin.RelationOtherSource ||
		e.InstalledFrom != strings.TrimPrefix(g.srv.URL, "http://")+"/index.json" {
		t.Errorf("entry: %s from %s, relation %s, installed from %q", e.Version, e.Registry, e.Relation, e.InstalledFrom)
	}
	// The update check names it, as no offer.
	ups, err := m.CheckUpdates(ctx, true)
	want := plugin.PluginUpdate{Name: "hello", Current: "0.1.0", Version: "0.5.0", Registry: g.srv.URL + "/index2.json",
		InstalledFrom: strings.TrimPrefix(g.srv.URL, "http://") + "/index.json"}
	if err != nil || len(ups) != 1 || ups[0] != want {
		t.Fatalf("check = %+v, %v; want %+v", ups, err, want)
	}
	if p, _ := m.Snapshot().Plugin("hello"); p.Update != nil {
		t.Fatalf("offer = %+v", p.Update)
	}
	if ups, err := m.Update(ctx, "", false, false); err != nil || len(ups) != 1 || ups[0].Updated || ups[0].Error != "" {
		t.Fatalf("update = %+v, %v", ups, err)
	}
	if p, _ := m.Snapshot().Plugin("hello"); p.Manifest.Version != "0.1.0" {
		t.Fatalf("version = %s", p.Manifest.Version)
	}
}

// TestUpdateFromARegistryEntryOfTheReleaseRepo: a plugin installed straight from
// owner/repo is offered the version a registry entry of that repository lists, and the
// update installs that repository's release: the same source, so no takeover (its
// consent, secret and data stay) and it stays a release install.
func TestUpdateFromARegistryEntryOfTheReleaseRepo(t *testing.T) {
	g := newRegRig(t)
	ctx := context.Background()
	g.ghRelease("o/hello", g.build("hello", "0.1.0", basePerms))
	m := g.start()
	if _, err := m.Install(ctx, plugin.InstallRequest{Ref: "o/hello", Enable: true, Consent: true}); err != nil {
		t.Fatal(err)
	}
	g.waitState("hello", plugin.StateRunning)
	if r, err := g.invoke("plugin.hello.remember", map[string]string{"word": "swordfish"}, command.Context{}); err != nil || r.Message != "remembered" {
		t.Fatalf("remember = %+v, %v", r, err)
	}
	if err := os.WriteFile(filepath.Join(g.opts.DataDir, "hello", "state"), []byte("kept"), 0o600); err != nil {
		t.Fatal(err)
	}
	r := g.build("hello", "0.2.0", basePerms)
	g.publish(r, basePerms) // repo o/hello
	g.ghRelease("o/hello", r)

	br, err := m.Browse(ctx, true)
	if err != nil || len(br.Entries) != 1 || br.Entries[0].Relation != plugin.RelationUpdate || br.Entries[0].InstalledFrom != "" {
		t.Fatalf("browse = %+v, %v", br, err)
	}
	if p, _ := m.Snapshot().Plugin("hello"); p.Update == nil || p.Update.Ref != "o/hello@v0.2.0" || p.Update.Registry != g.srv.URL+"/index.json" {
		t.Fatalf("offer = %+v", p.Update)
	}
	ups, err := m.Update(ctx, "hello", false, false)
	if err != nil || len(ups) != 1 || !ups[0].Updated || ups[0].Error != "" || ups[0].Version != "0.2.0" {
		t.Fatalf("update = %+v, %v", ups, err)
	}
	p := g.waitState("hello", plugin.StateRunning)
	if p.Manifest.Version != "0.2.0" || p.Installed == nil || p.Installed.Kind != plugin.KindGitHub || p.Installed.Source != "o/hello" || p.Update != nil {
		t.Fatalf("after the update: %s, record %+v, offer %+v", p.Manifest.Version, p.Installed, p.Update)
	}
	g.assertSecretKept(ctx, m)
	if br, _ := m.Browse(ctx, false); br.Entries[0].Relation != plugin.RelationInstalled {
		t.Errorf("relation after the update = %s", br.Entries[0].Relation)
	}
}

// TestDevOverAnInstalledPackage: plugin dev of a folder whose plugin has the name of a
// registry install is refused without --force (the package stays, with its secret);
// with it the package goes, the link takes its place, and the link starts empty.
func TestDevOverAnInstalledPackage(t *testing.T) {
	g := newRegRig(t)
	ctx := context.Background()
	g.publish(g.build("hello", "0.1.0", basePerms), basePerms)
	m := g.start()
	g.enabledWithSecret(ctx, m)
	src := g.install(t.TempDir(), "hello", "ok", testManifest("hello"))
	real, _ := filepath.EvalSymlinks(src)
	link := filepath.Join(g.opts.Dir, "hello")

	if _, err := m.Dev(ctx, src, true, false, false); !errors.Is(err, plugin.ErrFailedPrecondition) ||
		!strings.Contains(err.Error(), "--force replaces it with a link to "+real) {
		t.Fatalf("dev over a package without --force: %v", err)
	}
	if fi, err := os.Lstat(link); err != nil || fi.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("the package was touched: %v", err)
	}
	g.assertSecretKept(ctx, m)
	res, err := m.Dev(ctx, src, false, true, true)
	if err != nil || !res.NeedsConsent || !strings.Contains(res.Consent, "It replaces the plugin hello from the registry") {
		t.Fatalf("forced dry run = %+v, %v", res, err)
	}
	g.assertSecretKept(ctx, m)
	if _, err := m.Dev(ctx, src, true, false, true); err != nil {
		t.Fatal(err)
	}
	if p := g.waitState("hello", plugin.StateRunning); p.DevPath != real {
		t.Fatalf("linked to %s", p.DevPath)
	}
	if target, err := os.Readlink(link); err != nil || target != real {
		t.Fatalf("link %q, %v", target, err)
	}
	g.assertPurged(ctx, m)
	if r, _ := g.invoke("plugin.hello.recall", nil, command.Context{}); r.Message != "nothing" {
		t.Errorf("recall after the takeover = %q", r.Message)
	}
}
