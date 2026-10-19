package plugin

import (
	"testing"

	"github.com/alexwaumann/code-foundry/internal/store/plugin/registry"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// TestRelationAndOffer: Browse's relation and the Installed row's offer are one
// decision. An entry offers an update only when it comes from the source the plugin was
// installed from: its registry, or for a release install an entry of the same repository
// (whichever registry lists it). docs/notes/plugins-browse-offer.md.
func TestRelationAndOffer(t *testing.T) {
	const regA, regB = "https://github.com/o/reg-a", "http://127.0.0.1:8765/index.json"
	installed := func(version string, kind InstallKind, source string) *Plugin {
		p := &Plugin{Name: "hello", Manifest: pluginsdk.Manifest{Name: "hello", Version: version}}
		if kind != "" {
			p.Installed = &InstallRecord{Kind: kind, Source: source, Version: version}
		}
		return p
	}
	entry := func(version, reg, repo string) registry.Entry {
		return registry.Entry{Name: "hello", Version: version, Registry: reg, Repo: repo}
	}
	dev := installed("0.1.0", KindPath, "/src/hello")
	dev.Dev, dev.DevPath = true, "/src/hello"
	tests := []struct {
		name     string
		p        *Plugin
		e        registry.Entry
		releases map[string]UpdateOffer
		want     Relation
		from     string // SourceLabel when other_source
		offer    *UpdateOffer
	}{
		{name: "not installed", e: entry("0.2.0", regA, "o/hello"), want: RelationNotInstalled},
		{name: "same registry, newer", p: installed("0.1.0", KindRegistry, regA), e: entry("0.2.0", regA, "o/hello"),
			want: RelationUpdate, offer: &UpdateOffer{Version: "0.2.0", Registry: regA}},
		{name: "same registry, same version", p: installed("0.2.0", KindRegistry, regA), e: entry("0.2.0", regA, "o/hello"), want: RelationInstalled},
		{name: "same registry, installed newer", p: installed("0.3.0", KindRegistry, regA), e: entry("0.2.0", regA, "o/hello"), want: RelationInstalled},
		{name: "other registry, newer", p: installed("0.1.0", KindRegistry, regB), e: entry("0.2.0", regA, "evil/hello"),
			want: RelationOtherSource, from: "127.0.0.1:8765/index.json"},
		// A registry install is bound to its registry, not to the repository its entry named.
		{name: "other registry, same repo", p: installed("0.1.0", KindRegistry, regB), e: entry("0.2.0", regA, "o/hello"),
			want: RelationOtherSource, from: "127.0.0.1:8765/index.json"},
		{name: "release, registry entry of that repo", p: installed("0.1.0", KindGitHub, "O/Hello"), e: entry("0.2.0", regA, "o/hello"),
			want: RelationUpdate, offer: &UpdateOffer{Version: "0.2.0", Registry: regA, Ref: "O/Hello@v0.2.0"}},
		{name: "release, registry entry of that repo, current", p: installed("0.2.0", KindGitHub, "o/hello"), e: entry("0.2.0", regA, "o/hello"),
			want: RelationInstalled, releases: map[string]UpdateOffer{"hello": {Version: "0.3.0", Registry: "https://github.com/o/hello", Ref: "o/hello@v0.3.0"}}},
		{name: "release, registry entry of another repo", p: installed("0.1.0", KindGitHub, "o/hello"), e: entry("0.2.0", regA, "evil/hello"),
			want: RelationOtherSource, from: "o/hello"},
		{name: "release, another repo's entry, own release newer", p: installed("0.1.0", KindGitHub, "o/hello"), e: entry("0.2.0", regA, "evil/hello"),
			releases: map[string]UpdateOffer{"hello": {Version: "0.1.5", Registry: "https://github.com/o/hello", Ref: "o/hello@v0.1.5"}},
			want:     RelationOtherSource, from: "o/hello", offer: &UpdateOffer{Version: "0.1.5", Registry: "https://github.com/o/hello", Ref: "o/hello@v0.1.5"}},
		{name: "release, entry without a repo", p: installed("0.1.0", KindGitHub, "o/hello"), e: entry("0.2.0", regA, ""),
			want: RelationOtherSource, from: "o/hello"},
		{name: "put in plugins/ by hand", p: installed("0.1.0", "", ""), e: entry("0.2.0", regA, "o/hello"),
			want: RelationOtherSource, from: "the plugins folder"},
		{name: "dev link", p: dev, e: entry("0.2.0", regA, "o/hello"), want: RelationDev},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := relate(tt.p, tt.e); got != tt.want {
				t.Errorf("relate = %s, want %s", got, tt.want)
			}
			if tt.want == RelationOtherSource {
				if got := SourceLabel(*tt.p); got != tt.from {
					t.Errorf("SourceLabel = %q, want %q", got, tt.from)
				}
			}
			if tt.p == nil {
				return
			}
			o, ok := offerFor(*tt.p, registry.Merged{Entries: []registry.Entry{tt.e}}, tt.releases)
			switch {
			case tt.offer == nil && ok:
				t.Errorf("offer = %+v, want none", o)
			case tt.offer != nil && (!ok || o != *tt.offer):
				t.Errorf("offer = %+v (%v), want %+v", o, ok, *tt.offer)
			}
			// Browse offers Update exactly when the Installed row does, for a listed entry
			// (a release's own offer is the Installed row's alone).
			if (relate(tt.p, tt.e) == RelationUpdate) != (ok && o.Registry == tt.e.Registry) {
				t.Errorf("Browse and the Installed row disagree: relation %s, offer %+v (%v)", relate(tt.p, tt.e), o, ok)
			}
		})
	}
}

func TestShortURL(t *testing.T) {
	for in, want := range map[string]string{
		"https://github.com/alexwaumann/code-foundry-plugins": "alexwaumann/code-foundry-plugins",
		"http://127.0.0.1:8765/index.json":                    "127.0.0.1:8765/index.json",
		"https://plugins.example.com/cf/index.json":           "plugins.example.com/cf/index.json",
	} {
		if got := ShortURL(in); got != want {
			t.Errorf("ShortURL(%q) = %q, want %q", in, got, want)
		}
	}
}
