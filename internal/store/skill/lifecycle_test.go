package skill_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/skill"
	"github.com/alexwaumann/code-foundry/internal/store/skill/marketplace"
	"github.com/alexwaumann/code-foundry/internal/store/skill/marketplace/marketplacetest"
	"github.com/alexwaumann/code-foundry/internal/store/skill/skilltest"
)

const prReviewPath = "enterprise/skills/pr-review"

// later is a commit after the fixture's history.
var later = time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)

func (h *harness) installed(t *testing.T, kind marketplace.Kind, name string) (skill.Installed, bool) {
	t.Helper()
	for _, in := range h.store.Installed() {
		if in.Kind == kind && in.Name == name {
			return in, true
		}
	}
	return skill.Installed{}, false
}

func (h *harness) record(t *testing.T, name string) (skill.Record, bool) {
	t.Helper()
	recs, err := skill.LoadRecords(context.Background(), h.db)
	if err != nil {
		t.Fatal(err)
	}
	r, ok := recs[name]
	return r, ok
}

func (h *harness) mustInstall(t *testing.T, name string) skill.Change {
	t.Helper()
	ch, err := h.store.Install(context.Background(), name, marketplace.KindSkill)
	if err != nil {
		t.Fatal(err)
	}
	return ch
}

func readFile(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestInstallSkill(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t)
	src := filepath.Join(h.checkout, filepath.FromSlash(prReviewPath))
	// The working tree is what is copied: an executable, a symlink (never copied), a subdir.
	if err := os.Chmod(filepath.Join(src, "install.sh"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/etc/passwd", filepath.Join(src, "passwd")); err != nil {
		t.Fatal(err)
	}
	writeSkill(t, filepath.Dir(src), "pr-review", "-", map[string]string{"references/checklist.md": "- tests\n"})
	h.load(t)

	ch := h.mustInstall(t, "pr-review")
	dir := filepath.Join(h.skillsDir, "pr-review")
	want := skill.Change{Op: skill.OpInstall, Kind: marketplace.KindSkill, Name: "pr-review", Registry: "ai-marketplace",
		Version: "20260305", Dir: dir, NeedsSetup: true, SetupScript: "install.sh"}
	if ch != want {
		t.Errorf("change =\n %+v\nwant\n %+v", ch, want)
	}
	if got := readFile(t, filepath.Join(dir, "references", "checklist.md")); got != "- tests\n" {
		t.Errorf("checklist = %q", got)
	}
	modes := map[string]os.FileMode{"install.sh": 0o755, "SKILL.md": 0o644, "references": os.ModeDir | 0o755}
	for name, mode := range modes {
		fi, err := os.Lstat(filepath.Join(dir, name))
		if err != nil || fi.Mode() != mode {
			t.Errorf("%s: mode %v, err %v; want %v", name, fi.Mode(), err, mode)
		}
	}
	if _, err := os.Lstat(filepath.Join(dir, "passwd")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the symlink was copied: %v", err)
	}
	if ents, _ := filepath.Glob(filepath.Join(h.skillsDir, ".cf-*")); len(ents) != 0 {
		t.Errorf("staging left behind: %v", ents)
	}
	r, ok := h.record(t, "pr-review")
	head := marketplacetest.Git(t, h.checkout, time.Time{}, "log", "-1", "--format=%H", "--", prReviewPath)
	if !ok || r.Registry != "ai-marketplace" || r.Path != prReviewPath || r.Tier != marketplace.TierEnterprise ||
		r.CommitSHA != head || !r.CommitAt.Equal(marketplacetest.PRReview) || r.SetupScript != "install.sh" ||
		r.SetupSHA256 != sha("#!/bin/sh\necho installing\n") || !r.SetupDoneAt.IsZero() || !r.InstalledAt.Equal(now) {
		t.Errorf("record = %+v", r)
	}
	in, _ := h.installed(t, marketplace.KindSkill, "pr-review")
	if !in.Enabled || in.Local || !in.NeedsSetup || in.Update != nil {
		t.Errorf("installed = %+v", in)
	}

	// Again: nothing to do.
	again, err := h.store.Install(ctx, "pr-review", "")
	if err != nil || !again.Unchanged || again.Dir != dir {
		t.Errorf("second install = %+v, %v", again, err)
	}
	// A skill without a setup script.
	if ch := h.mustInstall(t, "haiku-writer"); ch.NeedsSetup || ch.SetupScript != "" || ch.Version != "20260110" {
		t.Errorf("haiku-writer = %+v", ch)
	}
	if r, _ := h.record(t, "haiku-writer"); r.SetupScript != "" || r.SetupSHA256 != "" {
		t.Errorf("haiku-writer record = %+v", r)
	}
	// No claude call installs a skill: only the reads.
	for _, c := range h.claude.Calls() {
		if c[1] != "list" && c[2] != "list" {
			t.Errorf("unexpected claude call %v", c)
		}
	}
}

func TestInstallSkillRefusals(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name    string
		prepare func(t *testing.T, h *harness)
		install string
		wantErr error
		wantMsg string
	}{
		{
			name:    "local skill of that name",
			prepare: func(t *testing.T, h *harness) { writeSkill(t, h.skillsDir, "pr-review", "name: mine", nil) },
			install: "pr-review", wantErr: skill.ErrCollision, wantMsg: "already exists and Code Foundry did not install it",
		},
		{
			name:    "a directory without SKILL.md",
			prepare: func(t *testing.T, h *harness) { writeSkill(t, h.skillsDir, "pr-review", "-", map[string]string{"x": "y"}) },
			install: "pr-review", wantErr: skill.ErrCollision, wantMsg: "/pr-review already exists",
		},
		{
			name:    "a disabled local skill",
			prepare: func(t *testing.T, h *harness) { writeSkill(t, h.disabled, "pr-review", "name: mine", nil) },
			install: "pr-review", wantErr: skill.ErrCollision, wantMsg: filepath.Join("disabled", "pr-review"),
		},
		{
			name: "installed from another entry",
			prepare: func(t *testing.T, h *harness) {
				writeSkill(t, h.skillsDir, "pr-review", "name: pr-review", nil)
				if err := skill.SaveRecord(ctx, h.db, skill.Record{Name: "pr-review", Registry: "other", Path: "community/skills/pr-review", InstalledAt: now}); err != nil {
					t.Fatal(err)
				}
			},
			install: "pr-review", wantErr: skill.ErrCollision, wantMsg: "was installed from other (community/skills/pr-review), not ai-marketplace",
		},
		{
			name: "a name that is not a directory name",
			prepare: func(t *testing.T, h *harness) {
				marketplacetest.Commit(t, h.checkout, later, map[string]string{"community/skills/evil/SKILL.md": "---\nname: ../evil\n---\n"})
			},
			install: "../evil", wantErr: skill.ErrInvalidName,
		},
		{name: "unknown", install: "nope", wantErr: skill.ErrNotFound, wantMsg: `no skill named "nope"`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t)
			if tt.prepare != nil {
				tt.prepare(t, h)
			}
			h.load(t)
			_, err := h.store.Install(ctx, tt.install, marketplace.KindSkill)
			if !errors.Is(err, tt.wantErr) || !strings.Contains(err.Error(), tt.wantMsg) {
				t.Fatalf("err = %v, want %v containing %q", err, tt.wantErr, tt.wantMsg)
			}
		})
	}
	// A record from another entry whose directory is gone: the install takes the name.
	h := newHarness(t)
	if err := skill.SaveRecord(ctx, h.db, skill.Record{Name: "pr-review", Registry: "other", Path: "x", InstalledAt: now}); err != nil {
		t.Fatal(err)
	}
	h.load(t)
	h.mustInstall(t, "pr-review")
	if r, _ := h.record(t, "pr-review"); r.Registry != "ai-marketplace" || r.Path != prReviewPath {
		t.Errorf("record = %+v", r)
	}
}

func TestEnableDisableSkill(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t)
	h.load(t)
	h.mustInstall(t, "pr-review")
	enabled, disabled := filepath.Join(h.skillsDir, "pr-review"), filepath.Join(h.disabled, "pr-review")

	steps := []struct {
		name      string
		enable    bool
		unchanged bool
		dir       string
	}{
		{"disable", false, false, disabled},
		{"disable again", false, true, disabled},
		{"enable", true, false, enabled},
		{"enable again", true, true, enabled},
	}
	for _, st := range steps {
		op := h.store.Disable
		if st.enable {
			op = h.store.Enable
		}
		ch, err := op(ctx, "pr-review", "")
		if err != nil {
			t.Fatalf("%s: %v", st.name, err)
		}
		if ch.Unchanged != st.unchanged || ch.Dir != st.dir {
			t.Errorf("%s: change = %+v", st.name, ch)
		}
		in, _ := h.installed(t, marketplace.KindSkill, "pr-review")
		if in.Enabled != st.enable || in.Dir != st.dir || !exists(st.dir) || exists(otherOf(st.dir, enabled, disabled)) {
			t.Errorf("%s: installed = %+v", st.name, in)
		}
	}

	// Both places taken: refused, naming the one in the way.
	writeSkill(t, h.disabled, "pr-review", "name: stale", nil)
	if _, err := h.store.Disable(ctx, "pr-review", marketplace.KindSkill); !errors.Is(err, skill.ErrCollision) || !strings.Contains(err.Error(), disabled) {
		t.Errorf("disable onto a leftover: %v", err)
	}
	if err := os.RemoveAll(disabled); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name    string
		prepare func(t *testing.T)
		target  string
		wantErr error
	}{
		{"local", func(t *testing.T) { writeSkill(t, h.skillsDir, "mine", "name: mine", nil) }, "mine", skill.ErrLocal},
		{"missing", func(t *testing.T) {
			if err := skill.SaveRecord(ctx, h.db, skill.Record{Name: "gone", Registry: "ai-marketplace", Path: "x", InstalledAt: now}); err != nil {
				t.Fatal(err)
			}
		}, "gone", skill.ErrNotFound},
		{"unknown", nil, "nope", skill.ErrNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.prepare != nil {
				tt.prepare(t)
			}
			for _, op := range []func(context.Context, string, marketplace.Kind) (skill.Change, error){h.store.Enable, h.store.Disable} {
				if _, err := op(ctx, tt.target, ""); !errors.Is(err, tt.wantErr) {
					t.Errorf("err = %v, want %v", err, tt.wantErr)
				}
			}
		})
	}
}

func otherOf(dir, a, b string) string {
	if dir == a {
		return b
	}
	return a
}

func exists(p string) bool {
	_, err := os.Lstat(p)
	return err == nil
}

func TestUpdateSkill(t *testing.T) {
	ctx := context.Background()
	script := "#!/bin/sh\necho installing\n"
	tests := []struct {
		name         string
		disable      bool
		setupDone    bool
		change       map[string]string // committed at later, after the install
		wantUpdated  bool
		wantDoneKept bool
	}{
		{name: "not offered", setupDone: true, wantDoneKept: true},
		{name: "offered, script unchanged", setupDone: true, change: map[string]string{prReviewPath + "/SKILL.md": "---\nname: pr-review\n---\nv2\n"},
			wantUpdated: true, wantDoneKept: true},
		{name: "offered, script changed", setupDone: true, change: map[string]string{prReviewPath + "/install.sh": script + "echo more\n"},
			wantUpdated: true},
		{name: "offered, setup never ran", change: map[string]string{prReviewPath + "/SKILL.md": "---\nname: pr-review\n---\nv2\n"},
			wantUpdated: true},
		{name: "disabled, offered", disable: true, setupDone: true, change: map[string]string{prReviewPath + "/SKILL.md": "---\nname: pr-review\n---\nv2\n"},
			wantUpdated: true, wantDoneKept: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t)
			h.load(t)
			h.mustInstall(t, "pr-review")
			dir := filepath.Join(h.skillsDir, "pr-review")
			if tt.disable {
				if _, err := h.store.Disable(ctx, "pr-review", ""); err != nil {
					t.Fatal(err)
				}
				dir = filepath.Join(h.disabled, "pr-review")
			}
			if tt.setupDone {
				if _, err := h.store.Setup(ctx, "pr-review"); err != nil {
					t.Fatal(err)
				}
				if err := h.store.SetupExited(ctx, "pr-review", 0); err != nil {
					t.Fatal(err)
				}
			}
			before, _ := h.record(t, "pr-review")
			if tt.change != nil {
				marketplacetest.Commit(t, h.checkout, later, tt.change)
				h.load(t)
				if in, _ := h.installed(t, marketplace.KindSkill, "pr-review"); in.Update == nil || in.Update.Version != "20260901" {
					t.Fatalf("no offer: %+v", in)
				}
				if got := h.store.Updates(marketplace.KindSkill); len(got) != 1 || got[0].Name != "pr-review" {
					t.Errorf("Updates = %+v", got)
				}
			}
			chs, err := h.store.Update(ctx, "pr-review", marketplace.KindSkill)
			if err != nil || len(chs) != 1 {
				t.Fatalf("update = %+v, %v", chs, err)
			}
			ch := chs[0]
			if ch.Unchanged == tt.wantUpdated || ch.PreviousVersion != "20260305" || ch.Dir != dir {
				t.Errorf("change = %+v", ch)
			}
			r, _ := h.record(t, "pr-review")
			if tt.wantUpdated {
				for rel, content := range tt.change {
					if got := readFile(t, filepath.Join(dir, strings.TrimPrefix(rel, prReviewPath+"/"))); got != content {
						t.Errorf("%s = %q", rel, got)
					}
				}
				if !r.CommitAt.Equal(later) || ch.Version != "20260901" || !r.InstalledAt.Equal(before.InstalledAt) {
					t.Errorf("record = %+v, change %+v", r, ch)
				}
			} else if !r.CommitAt.Equal(before.CommitAt) {
				t.Errorf("record changed: %+v", r)
			}
			if kept := !r.SetupDoneAt.IsZero(); kept != tt.wantDoneKept {
				t.Errorf("setup done kept = %t, want %t (record %+v)", kept, tt.wantDoneKept, r)
			}
			if ch.NeedsSetup == tt.wantDoneKept {
				t.Errorf("needs setup = %t", ch.NeedsSetup)
			}
			if ents, _ := filepath.Glob(filepath.Join(filepath.Dir(dir), ".cf-*")); len(ents) != 0 {
				t.Errorf("staging left behind: %v", ents)
			}
			if exists(otherOf(dir, filepath.Join(h.skillsDir, "pr-review"), filepath.Join(h.disabled, "pr-review"))) {
				t.Error("the update copied into the other place")
			}
		})
	}
}

func TestUpdateEvery(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t)
	h.claude.SetAvailable("enterprise-data@ai-marketplace", "1.3.0")
	h.load(t)
	if _, err := h.store.Install(ctx, "enterprise-data", ""); err != nil {
		t.Fatal(err)
	}
	h.mustInstall(t, "pr-review")
	h.mustInstall(t, "haiku-writer")
	marketplacetest.Commit(t, h.checkout, later, map[string]string{prReviewPath + "/SKILL.md": "---\nname: pr-review\n---\nv2\n"})
	h.claude.SetAvailable("enterprise-data@ai-marketplace", "1.4.0") // the index lists 1.4.0
	h.load(t)
	if got := h.store.Updates(""); len(got) != 2 {
		t.Fatalf("Updates = %+v", got)
	}
	chs, err := h.store.Update(ctx, "", "")
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, ch := range chs {
		got = append(got, string(ch.Kind)+" "+ch.Name+" "+ch.PreviousVersion+"→"+ch.Version+" "+ch.Error)
	}
	want := []string{"plugin enterprise-data 1.3.0→1.4.0 ", "skill pr-review 20260305→20260901 "}
	if !slices.Equal(got, want) {
		t.Errorf("changes = %q, want %q", got, want)
	}
	if got := h.store.Updates(""); len(got) != 0 {
		t.Errorf("offers left: %+v", got)
	}
	// A failure is that change's error; the others still run.
	marketplacetest.Commit(t, h.checkout, later.Add(time.Hour), map[string]string{prReviewPath + "/SKILL.md": "v3"})
	h.claude.SetAvailable("enterprise-data@ai-marketplace", "1.4.0")
	h.load(t)
	if err := os.Chmod(h.skillsDir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(h.skillsDir, 0o755) })
	chs, err = h.store.Update(ctx, "", marketplace.KindSkill)
	if err != nil || len(chs) != 1 || chs[0].Error == "" {
		t.Errorf("failed update = %+v, %v", chs, err)
	}
}

func TestUninstallAndRemoveSkill(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t)
	h.load(t)
	h.mustInstall(t, "pr-review")
	h.mustInstall(t, "haiku-writer")
	if _, err := h.store.Disable(ctx, "haiku-writer", ""); err != nil {
		t.Fatal(err)
	}
	writeSkill(t, h.skillsDir, "mine", "name: mine", nil)
	writeSkill(t, h.disabled, "old-mine", "name: old", nil)
	// A local skill that is a symlink: Remove deletes the link, not its target.
	linked := filepath.Join(t.TempDir(), "linked")
	writeSkill(t, filepath.Dir(linked), "linked", "name: linked", nil)
	if err := os.Symlink(linked, filepath.Join(h.skillsDir, "linked")); err != nil {
		t.Fatal(err)
	}
	h.load(t)

	tests := []struct {
		name    string
		remove  bool
		target  string
		wantErr error
		gone    []string
	}{
		{name: "uninstall enabled", target: "pr-review", gone: []string{filepath.Join(h.skillsDir, "pr-review")}},
		{name: "uninstall disabled", target: "haiku-writer", gone: []string{filepath.Join(h.disabled, "haiku-writer")}},
		{name: "uninstall local", target: "mine", wantErr: skill.ErrLocal},
		{name: "remove recorded", remove: true, target: "pr-review", wantErr: skill.ErrNotFound}, // uninstalled above
		{name: "remove local", remove: true, target: "mine", gone: []string{filepath.Join(h.skillsDir, "mine")}},
		{name: "remove disabled local", remove: true, target: "old-mine", gone: []string{filepath.Join(h.disabled, "old-mine")}},
		{name: "remove symlinked local", remove: true, target: "linked", gone: []string{filepath.Join(h.skillsDir, "linked")}},
		{name: "remove unknown", remove: true, target: "nope", wantErr: skill.ErrNotFound},
		{name: "uninstall unknown", target: "nope", wantErr: skill.ErrNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var err error
			if tt.remove {
				_, err = h.store.Remove(ctx, tt.target)
			} else {
				_, err = h.store.Uninstall(ctx, tt.target, "")
			}
			if !errors.Is(err, tt.wantErr) || tt.wantErr == nil && err != nil {
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			for _, p := range tt.gone {
				if exists(p) {
					t.Errorf("%s is still there", p)
				}
			}
			if _, ok := h.record(t, tt.target); ok {
				t.Errorf("record of %s left", tt.target)
			}
			if _, ok := h.installed(t, marketplace.KindSkill, tt.target); ok && tt.wantErr == nil {
				t.Errorf("%s still listed", tt.target)
			}
		})
	}
	if readFile(t, filepath.Join(linked, "SKILL.md")) == "" {
		t.Error("the symlink's target was deleted")
	}
	// Remove refuses a skill Code Foundry installed.
	h.mustInstall(t, "pr-review")
	if _, err := h.store.Remove(ctx, "pr-review"); !errors.Is(err, skill.ErrLocal) || !strings.Contains(err.Error(), "uninstall it instead") {
		t.Errorf("remove recorded: %v", err)
	}
}

func TestPluginLifecycle(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t)
	h.claude.SetAvailable("enterprise-data@ai-marketplace", "1.4.0")
	h.load(t)
	id := "enterprise-data@ai-marketplace"

	type step struct {
		name      string
		run       func() (skill.Change, error)
		wantArgs  string
		unchanged bool
		enabled   bool
		version   string
		msg       string
	}
	pick := func(chs []skill.Change, err error) (skill.Change, error) {
		if err != nil || len(chs) != 1 {
			return skill.Change{}, errors.Join(err, errors.New("not one change"))
		}
		return chs[0], nil
	}
	steps := []step{
		{name: "install", run: func() (skill.Change, error) { return h.store.Install(ctx, "enterprise-data", "") },
			wantArgs: "plugin install " + id + " -y --json", enabled: true, version: "1.4.0", msg: "Successfully installed plugin: " + id + " (scope: user)"},
		{name: "install again", run: func() (skill.Change, error) { return h.store.Install(ctx, id, "") },
			wantArgs: "plugin install " + id + " -y --json", unchanged: true, enabled: true, version: "1.4.0"},
		{name: "disable", run: func() (skill.Change, error) { return h.store.Disable(ctx, "enterprise-data", marketplace.KindPlugin) },
			wantArgs: "plugin disable " + id + " --json", version: "1.4.0"},
		{name: "disable again", run: func() (skill.Change, error) { return h.store.Disable(ctx, "enterprise-data", "") },
			wantArgs: "plugin disable " + id + " --json", unchanged: true, version: "1.4.0", msg: `Plugin "` + id + `" is already disabled`},
		{name: "enable", run: func() (skill.Change, error) { return h.store.Enable(ctx, id, "") },
			wantArgs: "plugin enable " + id + " --json", enabled: true, version: "1.4.0"},
		{name: "update, latest", run: func() (skill.Change, error) { return pick(h.store.Update(ctx, "enterprise-data", "")) },
			wantArgs: "plugin update " + id + " -y --json", unchanged: true, enabled: true, version: "1.4.0"},
		{name: "update", run: func() (skill.Change, error) {
			h.claude.SetAvailable(id, "1.5.0")
			return pick(h.store.Update(ctx, "enterprise-data", ""))
		}, wantArgs: "plugin update " + id + " -y --json", enabled: true, version: "1.5.0"},
	}
	for _, st := range steps {
		ch, err := st.run()
		if err != nil {
			t.Fatalf("%s: %v", st.name, err)
		}
		calls := h.claude.Calls()
		var last string
		for _, c := range calls {
			if j := strings.Join(c, " "); !strings.HasSuffix(j, "list --json") {
				last = j
			}
		}
		if last != st.wantArgs {
			t.Errorf("%s: last op %q, want %q", st.name, last, st.wantArgs)
		}
		in, ok := h.installed(t, marketplace.KindPlugin, "enterprise-data")
		if !ok || in.Enabled != st.enabled || in.Version != st.version {
			t.Errorf("%s: installed = %+v", st.name, in)
		}
		if ch.Kind != marketplace.KindPlugin || ch.Name != "enterprise-data" || ch.Registry != "ai-marketplace" ||
			ch.Unchanged != st.unchanged || ch.Version != st.version || (st.msg != "" && ch.Message != st.msg) {
			t.Errorf("%s: change = %+v", st.name, ch)
		}
	}
	ch, err := h.store.Uninstall(ctx, "enterprise-data", "")
	if err != nil || ch.Op != skill.OpUninstall || ch.Version != "1.5.0" {
		t.Fatalf("uninstall = %+v, %v", ch, err)
	}
	if got := h.claude.Calls()[len(h.claude.Calls())-3]; strings.Join(got, " ") != "plugin uninstall "+id+" -y --scope user --json" {
		t.Errorf("uninstall argv = %v", got)
	}
	if _, ok := h.installed(t, marketplace.KindPlugin, "enterprise-data"); ok {
		t.Error("still installed")
	}
	if _, err := h.store.Uninstall(ctx, "enterprise-data", ""); !errors.Is(err, skill.ErrNotFound) {
		t.Errorf("uninstall again: %v", err)
	}
}

func TestPluginFailures(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name    string
		prepare func(h *harness)
		run     func(h *harness) error
		wantErr error
		wantMsg string
	}{
		{
			name:    "claude does not know it",
			run:     func(h *harness) error { _, err := h.store.Install(ctx, "lint-kit", marketplace.KindPlugin); return err },
			wantErr: skill.ErrNotFound, wantMsg: `install plugin lint-kit@ai-marketplace: Plugin "lint-kit" not found in marketplace "ai-marketplace"`,
		},
		{
			name:    "claude fails without a result line",
			prepare: func(h *harness) { h.claude.Fail("plugin install", &skill.ClaudeError{Args: []string{"plugin", "install"}, Msg: "boom"}) },
			run:     func(h *harness) error { _, err := h.store.Install(ctx, "enterprise-data", ""); return err },
			wantMsg: "claude plugin install: boom",
		},
		{
			name:    "claude is missing",
			prepare: func(h *harness) { h.claude.Fail("plugin install", errors.New("run claude: not found")) },
			run:     func(h *harness) error { _, err := h.store.Install(ctx, "enterprise-data", ""); return err },
			wantMsg: "run claude: not found",
		},
		{
			name:    "not in the marketplace",
			run:     func(h *harness) error { _, err := h.store.Install(ctx, "nope@ai-marketplace", ""); return err },
			wantErr: skill.ErrNotFound, wantMsg: `no plugin named "nope" in marketplace "ai-marketplace"`,
		},
		{
			name: "two marketplaces",
			prepare: func(h *harness) {
				h.claude.Set(h.claude.Marketplaces, []skilltest.Plugin{{ID: "x@a", Version: "1"}, {ID: "x@b", Version: "1"}})
			},
			run:     func(h *harness) error { _, err := h.store.Disable(ctx, "x", ""); return err },
			wantErr: skill.ErrAmbiguous, wantMsg: "x@a or x@b",
		},
		{
			name: "a plugin and a skill",
			prepare: func(h *harness) {
				h.claude.Set(h.claude.Marketplaces, []skilltest.Plugin{{ID: "lint-kit@ai-marketplace", Version: "1", Enabled: true}})
				writeSkill(t, h.skillsDir, "lint-kit", "name: lint-kit", nil)
			},
			run:     func(h *harness) error { _, err := h.store.Disable(ctx, "lint-kit", ""); return err },
			wantErr: skill.ErrAmbiguous, wantMsg: "--kind plugin or --kind skill",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t)
			h.claude.SetAvailable("enterprise-data@ai-marketplace", "1.4.0")
			if tt.prepare != nil {
				tt.prepare(h)
			}
			h.load(t)
			err := tt.run(h)
			if err == nil || (tt.wantErr != nil && !errors.Is(err, tt.wantErr)) || !strings.Contains(err.Error(), tt.wantMsg) {
				t.Fatalf("err = %v, want %v containing %q", err, tt.wantErr, tt.wantMsg)
			}
		})
	}
	// The kind settles a shared name.
	h := newHarness(t)
	h.claude.Set(h.claude.Marketplaces, []skilltest.Plugin{{ID: "lint-kit@ai-marketplace", Version: "1", Enabled: true}})
	writeSkill(t, h.skillsDir, "lint-kit", "name: lint-kit", nil)
	h.load(t)
	if ch, err := h.store.Disable(ctx, "lint-kit", marketplace.KindPlugin); err != nil || ch.Kind != marketplace.KindPlugin {
		t.Errorf("disable --kind plugin = %+v, %v", ch, err)
	}
	if _, err := h.store.Disable(ctx, "lint-kit", marketplace.KindSkill); !errors.Is(err, skill.ErrLocal) {
		t.Errorf("disable --kind skill: %v", err)
	}
}

func TestSetup(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t)
	h.load(t)
	h.mustInstall(t, "pr-review")
	h.mustInstall(t, "haiku-writer")
	writeSkill(t, h.skillsDir, "mine", "name: mine", map[string]string{"install.sh": "echo"})
	h.load(t)
	dir := filepath.Join(h.skillsDir, "pr-review")

	plan, err := h.store.Setup(ctx, "pr-review")
	want := skill.SetupPlan{Name: "pr-review", Dir: dir, Script: "install.sh", Argv: []string{"/bin/sh", "install.sh"}}
	if err != nil || plan.Name != want.Name || plan.Dir != want.Dir || plan.Script != want.Script || !slices.Equal(plan.Argv, want.Argv) {
		t.Fatalf("plan = %+v, %v", plan, err)
	}
	needs := func() bool {
		in, _ := h.installed(t, marketplace.KindSkill, "pr-review")
		return in.NeedsSetup
	}
	// A failed run records nothing.
	if err := h.store.SetupExited(ctx, "pr-review", 1); err != nil || !needs() {
		t.Errorf("after exit 1: needs setup %t, %v", needs(), err)
	}
	if r, _ := h.record(t, "pr-review"); !r.SetupDoneAt.IsZero() {
		t.Errorf("record after exit 1 = %+v", r)
	}
	if _, err := h.store.Setup(ctx, "pr-review"); err != nil {
		t.Fatal(err)
	}
	// The script changes while it runs: the hash recorded is the one handed out.
	original := readFile(t, filepath.Join(dir, "install.sh"))
	if err := os.WriteFile(filepath.Join(dir, "install.sh"), []byte(original+"# edited\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := h.store.SetupExited(ctx, "pr-review", 0); err != nil {
		t.Fatal(err)
	}
	r, _ := h.record(t, "pr-review")
	if !r.SetupDoneAt.Equal(now) || r.SetupSHA256 != sha(original) || !needs() {
		t.Errorf("record = %+v, needs setup %t (the script changed since it was handed out)", r, needs())
	}
	if err := os.WriteFile(filepath.Join(dir, "install.sh"), []byte(original), 0o755); err != nil {
		t.Fatal(err)
	}
	h.load(t)
	if needs() {
		t.Error("needs setup with the script that ran")
	}
	// An exit nobody handed out (the daemon restarted): today's script is hashed.
	if err := h.store.SetupExited(ctx, "pr-review", 0); err != nil {
		t.Fatal(err)
	}
	if r, _ := h.record(t, "pr-review"); r.SetupSHA256 != sha(original) {
		t.Errorf("record = %+v", r)
	}

	for _, tt := range []struct {
		name    string
		wantErr error
	}{
		{"haiku-writer", skill.ErrNoSetup},
		{"mine", skill.ErrNoSetup},
		{"nope", skill.ErrNotFound},
	} {
		if _, err := h.store.Setup(ctx, tt.name); !errors.Is(err, tt.wantErr) {
			t.Errorf("setup %s: %v, want %v", tt.name, err, tt.wantErr)
		}
	}
	// Exits for skills without a script, or unknown ones, are ignored.
	for _, name := range []string{"haiku-writer", "nope"} {
		if err := h.store.SetupExited(ctx, name, 0); err != nil {
			t.Errorf("setup exited %s: %v", name, err)
		}
	}
	// Disabled: the script runs where the skill is.
	if _, err := h.store.Disable(ctx, "pr-review", ""); err != nil {
		t.Fatal(err)
	}
	if plan, err := h.store.Setup(ctx, "pr-review"); err != nil || plan.Dir != filepath.Join(h.disabled, "pr-review") {
		t.Errorf("disabled plan = %+v, %v", plan, err)
	}
}
