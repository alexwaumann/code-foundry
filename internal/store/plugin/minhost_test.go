package plugin_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/internal/store/plugin/registry"
	"github.com/alexwaumann/code-foundry/pluginsdk/pack"
)

// The running Code Foundry in these tests, older than the 0.31.0 the new versions need.
const oldHost = "v0.29.2"

// buildNeeding is build with the manifest's minHostVersion set.
func (g *regRig) buildNeeding(name, version, minHost string) pack.Result {
	g.t.Helper()
	mf := testManifest(name)
	mf.Version, mf.Permissions, mf.MinHostVersion = version, basePerms, minHost
	dir := g.install(filepath.Join(g.src, version+"-"+minHost), name, "ok", mf)
	r, err := pack.Tarball(dir, g.served, registry.Platform())
	if err != nil {
		g.t.Fatal(err)
	}
	return r
}

// stagingLeft lists what the installs left in the staging folder.
func stagingLeft(t *testing.T, m *plugin.Options) []string {
	t.Helper()
	ents, err := os.ReadDir(filepath.Join(m.Dir, plugin.StagingDir))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	var out []string
	for _, e := range ents {
		out = append(out, e.Name())
	}
	return out
}

func TestMinHostRegistryEntry(t *testing.T) {
	g := newRegRig(t)
	g.opts.HostVersion = oldHost
	ctx := context.Background()
	g.publish(g.buildNeeding("needy", "1.0.0", "0.31.0"), basePerms)
	g.publish(g.build("hello", "0.1.0", basePerms), basePerms)
	m := g.start()
	sub := bus.Subscribe[plugin.Event](m.Bus(), 256)
	defer sub.Close()

	// Browse says so, with the versions to show.
	br, err := m.Browse(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range br.Entries {
		want := e.Name == "needy"
		if e.NeedsHost != want || e.Host != "0.29.2" {
			t.Errorf("%s: NeedsHost %v (host %q), want %v", e.Name, e.NeedsHost, e.Host, want)
		}
	}

	// Install is refused from the index, before any download.
	_, err = m.Install(ctx, plugin.InstallRequest{Ref: "needy"})
	const msg = "needy 1.0.0 needs Code Foundry 0.31.0 or newer; this is 0.29.2"
	if !errors.Is(err, plugin.ErrFailedPrecondition) || !strings.Contains(err.Error(), msg) {
		t.Fatalf("install = %v, want failed precondition %q", err, msg)
	}
	if phases := progressPhases(sub, "needy"); strings.Contains(phases, "downloading") {
		t.Errorf("progress = %s: downloaded anyway", phases)
	}
	if _, ok := m.Snapshot().Plugin("needy"); ok {
		t.Error("installed anyway")
	}
	if left := stagingLeft(t, &g.opts); len(left) != 0 {
		t.Errorf("staging left %v", left)
	}

	// An installed plugin's newer version that needs a newer Code Foundry is held, not
	// an update: no offer, Update all passes over it, the check says why.
	if _, err := m.Install(ctx, plugin.InstallRequest{Ref: "hello"}); err != nil {
		t.Fatal(err)
	}
	g.publish(g.buildNeeding("hello", "0.2.0", "0.31.0"), basePerms)
	ups, err := m.CheckUpdates(ctx, true)
	want := plugin.PluginUpdate{Name: "hello", Current: "0.1.0", Version: "0.2.0", Registry: g.srv.URL + "/index.json", NeedsHost: "0.31.0", Host: "0.29.2"}
	if err != nil || len(ups) != 1 || ups[0] != want {
		t.Fatalf("check = %+v, %v; want %+v", ups, err, want)
	}
	p, _ := m.Snapshot().Plugin("hello")
	if p.Update != nil || p.HeldUpdate == nil || p.HeldUpdate.Version != "0.2.0" || p.HeldUpdate.MinHost != "0.31.0" || p.HeldUpdate.Host != "0.29.2" {
		t.Fatalf("snapshot update %+v, held %+v", p.Update, p.HeldUpdate)
	}
	done, err := m.Update(ctx, "", false, false)
	if err != nil || len(done) != 1 || done[0].Updated || done[0].Error != "" {
		t.Fatalf("update all = %+v, %v", done, err)
	}
	if p, _ := m.Snapshot().Plugin("hello"); p.Manifest.Version != "0.1.0" {
		t.Fatalf("updated to %s anyway", p.Manifest.Version)
	}
	br, _ = m.Browse(ctx, false)
	for _, e := range br.Entries {
		if e.Name == "hello" && (e.Relation != plugin.RelationUpdate || !e.NeedsHost) {
			t.Errorf("browse hello: %+v", e)
		}
	}

	// A version this Code Foundry runs is an update again.
	g.publish(g.buildNeeding("hello", "0.2.1", "0.29.0"), basePerms)
	ups, err = m.CheckUpdates(ctx, true)
	if err != nil || len(ups) != 1 || ups[0].Version != "0.2.1" || ups[0].NeedsHost != "" {
		t.Fatalf("check = %+v, %v", ups, err)
	}
	if p, _ := m.Snapshot().Plugin("hello"); p.Update == nil || p.Update.Version != "0.2.1" || p.HeldUpdate != nil {
		t.Fatalf("snapshot update %+v, held %+v", p.Update, p.HeldUpdate)
	}
}

func TestMinHostGitHubRelease(t *testing.T) {
	g := newRegRig(t)
	g.opts.HostVersion = oldHost
	ctx := context.Background()
	rel := func(tag string, assets ...string) string {
		var parts []string
		for _, a := range assets {
			parts = append(parts, fmt.Sprintf(`{"name":%q,"url":"https://github.com/o/ghp/releases/download/%s/%s"}`, a, tag, a))
		}
		return fmt.Sprintf(`{"tagName":%q,"assets":[%s]}`, tag, strings.Join(parts, ","))
	}
	publish := func(tag string, r pack.Result) {
		g.gh.Releases["o/ghp@"] = rel(tag, r.Base)
		g.gh.Releases["o/ghp@"+tag] = rel(tag, r.Base)
		g.gh.Assets["o/ghp/"+tag+"/"+r.Base] = r.File
	}
	publish("v0.2.0", g.buildNeeding("gh-plugin", "0.2.0", "0.31.0"))
	m := g.start()

	// No index to say so: the release is downloaded, its manifest read, and the install
	// refused before anything is put in place.
	_, err := m.Install(ctx, plugin.InstallRequest{Ref: "o/ghp", Enable: true, Consent: true})
	const msg = "gh-plugin 0.2.0 needs Code Foundry 0.31.0 or newer; this is 0.29.2"
	if !errors.Is(err, plugin.ErrFailedPrecondition) || !strings.Contains(err.Error(), msg) || strings.Contains(err.Error(), "not a valid package") {
		t.Fatalf("install = %v, want failed precondition %q", err, msg)
	}
	if _, ok := m.Snapshot().Plugin("gh-plugin"); ok {
		t.Error("installed anyway")
	}
	if _, err := os.Lstat(filepath.Join(g.opts.Dir, "gh-plugin")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("package dir: %v", err)
	}
	if left := stagingLeft(t, &g.opts); len(left) != 0 {
		t.Errorf("staging left %v", left)
	}

	// Installed at a version it runs, the repository's newer release that needs a newer
	// Code Foundry is held; its manifest is read once per version, not once per check.
	publish("v0.1.0", g.buildNeeding("gh-plugin", "0.1.0", ""))
	if _, err := m.Install(ctx, plugin.InstallRequest{Ref: "o/ghp@v0.1.0"}); err != nil {
		t.Fatal(err)
	}
	publish("v0.4.0", g.buildNeeding("gh-plugin", "0.4.0", "0.31.0"))
	resolves := func() int {
		n := 0
		for _, c := range g.gh.Calls() {
			if strings.HasPrefix(strings.Join(c, " "), "release view v0.4.0 -R o/ghp") {
				n++
			}
		}
		return n
	}
	for range 2 {
		ups, err := m.CheckUpdates(ctx, false)
		want := plugin.PluginUpdate{Name: "gh-plugin", Current: "0.1.0", Version: "0.4.0", Registry: "https://github.com/o/ghp", Ref: "o/ghp@v0.4.0", NeedsHost: "0.31.0", Host: "0.29.2"}
		if err != nil || len(ups) != 1 || ups[0] != want {
			t.Fatalf("check = %+v, %v; want %+v", ups, err, want)
		}
	}
	if n := resolves(); n != 1 {
		t.Errorf("release v0.4.0 resolved %d times in two checks, want 1", n)
	}
	if p, _ := m.Snapshot().Plugin("gh-plugin"); p.Update != nil || p.HeldUpdate == nil || p.HeldUpdate.Version != "0.4.0" {
		t.Errorf("snapshot update %+v, held %+v", p.Update, p.HeldUpdate)
	}
	if left := stagingLeft(t, &g.opts); len(left) != 0 {
		t.Errorf("staging left %v", left)
	}
	if done, err := m.Update(ctx, "gh-plugin", false, false); err != nil || len(done) != 1 || done[0].Updated {
		t.Fatalf("update = %+v, %v", done, err)
	}
}

// A package already on disk that needs a newer Code Foundry (a dev link, or one
// installed before a downgrade) does not start: a permanent failure saying why.
func TestMinHostRefusesStart(t *testing.T) {
	for _, tt := range []struct {
		name, host string
		starts     bool
	}{
		{name: "older", host: oldHost},
		{name: "new enough", host: "v0.31.0", starts: true},
		{name: "tip of it", host: "v0.31.0-tip.3", starts: true},
		{name: "dev build", host: "dev", starts: true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t, func(o *plugin.Options) { o.HostVersion = tt.host })
			mf := testManifest("hello")
			mf.MinHostVersion = "0.31.0"
			e.install(e.opts.Dir, "hello", "ok", mf)
			m := e.start()
			if _, err := m.Enable(context.Background(), "hello", true); err != nil {
				t.Fatal(err)
			}
			if tt.starts {
				e.waitState("hello", plugin.StateRunning)
				return
			}
			p := e.waitState("hello", plugin.StateFailed)
			if !strings.Contains(p.LastError, "hello 0.1.0 needs Code Foundry 0.31.0 or newer; this is 0.29.2") || p.Restarts != 1 {
				t.Fatalf("%+v", p)
			}
		})
	}
}
