package theme

import (
	"encoding/json"
	"maps"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestFrameDefaults(t *testing.T) {
	for scheme, id := range map[string]string{SchemeDark: "github-dark", SchemeLight: "github-light"} {
		f := DefaultFrame(scheme)
		if f.ID != id || f.Scheme != scheme {
			t.Errorf("default %s = %s (%s), want %s", scheme, f.ID, f.Scheme, id)
		}
		if err := f.Check(); err != nil {
			t.Errorf("default %s does not check: %v", scheme, err)
		}
		for _, name := range []string{"--cf-surface-raised", "--cf-text", "--cf-accent", "--cf-success-surface", "--terminal-ansi-15", "--syn-kw"} {
			if f.Vars[name] == "" {
				t.Errorf("default %s lacks %s", scheme, name)
			}
		}
	}
	if !strings.Contains(frameCSS, "  --card: var(--cf-surface-raised);\n") || !strings.Contains(frameCSS, ".text-body {") {
		t.Error("frame.css lacks the aliases or the type roles")
	}
}

func frame(vars map[string]string) Frame {
	return Frame{ID: "my-theme", Scheme: SchemeLight, Vars: vars}
}

// full is every slot (GitHub Light's values) with patch applied: a publishable set.
func full(patch map[string]string) map[string]string {
	v := DefaultFrame(SchemeLight).Vars
	maps.Copy(v, patch)
	return v
}

// without is full() minus the named slots.
func without(names ...string) map[string]string {
	v := full(nil)
	for _, n := range names {
		delete(v, n)
	}
	return v
}

func TestSlotNames(t *testing.T) {
	names := SlotNames()
	if len(names) != 102 {
		t.Errorf("%d slot names, want 102 (71 --cf-*, 21 terminal, 10 syntax)", len(names))
	}
	if light := DefaultFrame(SchemeLight); len(light.Vars) != len(names) {
		t.Errorf("the light default has %d vars, the dark %d", len(light.Vars), len(names))
	}
	names[0] = "changed"
	if SlotNames()[0] == "changed" {
		t.Error("SlotNames shares its slice")
	}
}

func TestFrameCheck(t *testing.T) {
	many := map[string]string{}
	for i := range maxVars + 1 {
		many["--cf-x"+strings.Repeat("a", i%60)+string(rune('a'+i%26))+string(rune('a'+i/26%26))] = "#000000"
	}
	tests := []struct {
		name    string
		f       Frame
		wantErr string
	}{
		{"ok", frame(full(map[string]string{"--cf-text": "#112233", "--cf-accent-surface": "#11223344", "--terminal-ansi-0": "#000000", "--syn-kw": "#AABBCC", "--sh-cmd": "#010203"})), ""},
		{"empty id", Frame{Scheme: SchemeDark, Vars: map[string]string{"--cf-text": "#000000"}}, "theme id"},
		{"id with a quote", Frame{ID: `a"b`, Scheme: SchemeDark, Vars: map[string]string{"--cf-text": "#000000"}}, "theme id"},
		{"upper-case id", Frame{ID: "GitHub", Scheme: SchemeDark, Vars: map[string]string{"--cf-text": "#000000"}}, "theme id"},
		{"bad scheme", Frame{ID: "x", Scheme: "auto", Vars: map[string]string{"--cf-text": "#000000"}}, "unknown scheme"},
		{"no vars", frame(nil), "no vars"},
		{"too many", frame(many), "at most"},
		{"component name", frame(full(map[string]string{"--card": "#000000"})), "want --cf-*"},
		{"injected name", frame(full(map[string]string{"--cf-x;}body{": "#000000"})), "want --cf-*"},
		{"named colour", frame(full(map[string]string{"--cf-text": "red"})), "not #rrggbb"},
		{"injected value", frame(full(map[string]string{"--cf-text": "#000000;}*{x:y"})), "not #rrggbb"},
		{"short hex", frame(full(map[string]string{"--cf-text": "#000"})), "not #rrggbb"},
		{"one slot missing", frame(without("--cf-text")), "missing 1 of the 102 slots: --cf-text"},
		{"two missing, named in order", frame(without("--syn-kw", "--cf-accent")), "missing 2 of the 102 slots: --cf-accent, --syn-kw"},
		{"a partial set", frame(map[string]string{"--cf-text": "#000000"}), "missing 101 of the 102 slots"},
		{"a misspelt slot", frame(full(map[string]string{"--cf-txet": "#000000"})), "1 unknown: --cf-txet"},
		{"a retired slot", frame(full(map[string]string{"--cf-sidebar-row-active": "#000000"})), "1 unknown: --cf-sidebar-row-active"},
		{"missing and unknown", frame(func() map[string]string { v := without("--cf-link"); v["--cf-lnik"] = "#000000"; return v }()), "missing 1 of the 102 slots: --cf-link; 1 unknown: --cf-lnik"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.f.Check()
			switch {
			case tt.wantErr == "" && err != nil:
				t.Fatalf("Check: %v", err)
			case tt.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tt.wantErr)):
				t.Fatalf("Check = %v, want an error containing %q", err, tt.wantErr)
			}
		})
	}
}

func TestLivePublish(t *testing.T) {
	l := NewLive()
	if _, ok := l.Current(); ok {
		t.Fatal("published before Publish")
	}
	if err := l.Publish(frame(map[string]string{"--cf-text": "nope"})); err == nil {
		t.Fatal("published a bad frame")
	}
	if _, ok := l.Current(); ok {
		t.Fatal("a refused frame became current")
	}
	vars := full(map[string]string{"--cf-text": "#112233"})
	if err := l.Publish(frame(vars)); err != nil {
		t.Fatal(err)
	}
	vars["--cf-text"] = "#ffffff" // the caller's map is not kept
	got, ok := l.Current()
	if !ok || got.Vars["--cf-text"] != "#112233" {
		t.Fatalf("Current = %+v, %v", got, ok)
	}
	got.Vars["--cf-text"] = "#000000" // nor is the returned one shared
	if again, _ := l.Current(); again.Vars["--cf-text"] != "#112233" {
		t.Fatal("Current's map is shared")
	}
	// A partial set is refused and the last good theme stays served.
	if err := l.Publish(Frame{ID: "partial", Scheme: SchemeDark, Vars: map[string]string{"--cf-text": "#445566"}}); err == nil {
		t.Fatal("published a partial set")
	}
	if got, _ := l.Current(); got.ID != "my-theme" || got.Vars["--cf-text"] != "#112233" {
		t.Fatalf("after a refused publish: %s %s", got.ID, got.Vars["--cf-text"])
	}
	// Last writer wins.
	if err := l.Publish(Frame{ID: "other", Scheme: SchemeDark, Vars: full(map[string]string{"--cf-text": "#445566"})}); err != nil {
		t.Fatal(err)
	}
	if got, _ := l.Current(); got.ID != "other" {
		t.Fatalf("after a second publish: %s", got.ID)
	}
}

func TestFrameHandler(t *testing.T) {
	published := NewLive()
	if err := published.Publish(Frame{ID: "rose-pine-dawn", Scheme: SchemeLight, Vars: full(map[string]string{
		"--cf-text": "#575279", "--cf-surface-raised": "#faf4ed", "--cf-accent": "#907aa9", "--cf-success-surface": "#6d8f891a",
	})}); err != nil {
		t.Fatal(err)
	}
	fresh := NewLive()
	dark, light := DefaultFrame(SchemeDark), DefaultFrame(SchemeLight)

	tests := []struct {
		name, method, path string
		live               *Live
		wantStatus         int
		wantType           string
		want, notWant      []string
	}{
		{"defaults before publish", http.MethodGet, "/cf/theme.css", fresh, http.StatusOK, "text/css; charset=utf-8",
			[]string{":root {\n  color-scheme: dark;\n", "  --cf-text: " + dark.Vars["--cf-text"] + ";\n",
				"@media (prefers-color-scheme: light) {\n  :root {\n    color-scheme: light;\n", "    --cf-text: " + light.Vars["--cf-text"] + ";\n",
				"  --background: var(--cf-canvas);\n", ".text-caption {", "  --radius-md: 6px;\n"}, nil},
		{"published vars", http.MethodGet, "/cf/theme.css", published, http.StatusOK, "text/css; charset=utf-8",
			[]string{"rose-pine-dawn (light)", ":root {\n  color-scheme: light;\n", "  --cf-accent: #907aa9;\n", "  --cf-success-surface: #6d8f891a;\n",
				"  --card: var(--cf-surface-raised);\n", ".text-body {"},
			[]string{"prefers-color-scheme", dark.Vars["--cf-surface"] + ";"}},
		{"pinned to the published theme's scheme", http.MethodGet, "/cf/theme.css?scheme=light", published, http.StatusOK, "text/css; charset=utf-8",
			[]string{"rose-pine-dawn (light)", "pinned to light", ":root {\n  color-scheme: light;\n", "  --cf-accent: #907aa9;\n", "@layer utilities {"},
			[]string{"prefers-color-scheme"}},
		{"pinned to the other scheme: its default", http.MethodGet, "/cf/theme.css?scheme=dark", published, http.StatusOK, "text/css; charset=utf-8",
			[]string{"github-dark, the dark default, pinned", ":root {\n  color-scheme: dark;\n", "  --cf-text: " + dark.Vars["--cf-text"] + ";\n"},
			[]string{"prefers-color-scheme", "#907aa9"}},
		{"pinned before publish: no media query", http.MethodGet, "/cf/theme.css?scheme=light", fresh, http.StatusOK, "text/css; charset=utf-8",
			[]string{":root {\n  color-scheme: light;\n", "  --cf-text: " + light.Vars["--cf-text"] + ";\n"},
			[]string{"prefers-color-scheme"}},
		{"an unknown scheme is the live theme", http.MethodGet, "/cf/theme.css?scheme=sepia", published, http.StatusOK, "text/css; charset=utf-8",
			[]string{"rose-pine-dawn (light), published by the GUI. */"}, []string{"pinned"}},
		{"json before publish", http.MethodGet, "/cf/theme.json", fresh, http.StatusOK, "application/json; charset=utf-8",
			[]string{`"id":"github-dark"`, `"scheme":"dark"`, `"published":false`}, nil},
		{"json published", http.MethodGet, "/cf/theme.json", published, http.StatusOK, "application/json; charset=utf-8",
			[]string{`"id":"rose-pine-dawn"`, `"scheme":"light"`, `"--cf-accent":"#907aa9"`, `"published":true`}, nil},
		{"head", http.MethodHead, "/cf/theme.css", published, http.StatusOK, "text/css; charset=utf-8", nil, nil},
		{"unknown path", http.MethodGet, "/cf/x", published, http.StatusNotFound, "", nil, nil},
		{"the prefix itself", http.MethodGet, "/cf/", published, http.StatusNotFound, "", nil, nil},
		{"a path under the stylesheet", http.MethodGet, "/cf/theme.css/x", published, http.StatusNotFound, "", nil, nil},
		{"post", http.MethodPost, "/cf/theme.css", published, http.StatusMethodNotAllowed, "", nil, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			// No Authorization header: the route needs none.
			FrameHandler(tt.live).ServeHTTP(rec, httptest.NewRequest(tt.method, tt.path, nil))
			if rec.Code != tt.wantStatus {
				t.Fatalf("status %d, want %d", rec.Code, tt.wantStatus)
			}
			if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
				t.Errorf("Access-Control-Allow-Origin %q", got)
			}
			if tt.wantStatus != http.StatusOK {
				return
			}
			for k, v := range map[string]string{"Content-Type": tt.wantType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"} {
				if got := rec.Header().Get(k); got != v {
					t.Errorf("%s %q, want %q", k, got, v)
				}
			}
			body := rec.Body.String()
			for _, w := range tt.want {
				if !strings.Contains(body, w) {
					t.Errorf("body lacks %q", w)
				}
			}
			for _, w := range tt.notWant {
				if strings.Contains(body, w) {
					t.Errorf("body has %q", w)
				}
			}
			if strings.HasSuffix(tt.path, ".json") {
				var j FrameJSON
				if err := json.Unmarshal(rec.Body.Bytes(), &j); err != nil || j.ID == "" || len(j.Vars) == 0 {
					t.Errorf("json %+v: %v", j, err)
				}
			}
		})
	}
}
