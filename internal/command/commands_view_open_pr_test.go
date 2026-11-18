package command_test

import (
	"context"
	"errors"
	"maps"
	"strings"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	core "github.com/alexwaumann/code-foundry/internal/layout"
	layoutstore "github.com/alexwaumann/code-foundry/internal/store/layout"
	"github.com/alexwaumann/code-foundry/internal/store/layout/layouttest"
	"github.com/alexwaumann/code-foundry/internal/store/notification"
	"github.com/alexwaumann/code-foundry/internal/store/notification/notificationtest"
)

// prFixture is newOpenFixture's layout (threadPane: self's tab focused in Main) over every
// command, with the gh store's answer prs and a notification store.
type prFixture struct {
	openFixture
	prs   *commandtest.PullRequestChecks
	notes *notificationtest.Store
}

func newPRFixture(t *testing.T, prs *commandtest.PullRequestChecks) prFixture {
	t.Helper()
	th := richThread()
	th.Id = self
	store := layouttest.New(nil)
	store.Put(threadPane())
	notes := notificationtest.New(t, notificationtest.Options{})
	reg, emit := panelRegistryWith(t, &commandtest.Thread{Current: th}, panelDeps{
		windows: 1, prs: prs, layout: store, notes: notes,
		projects: &commandtest.Project{Projects: []*v1.Project{{Id: "r1", GithubSlug: "owner/repo"}}},
	})
	return prFixture{openFixture: openFixture{reg: reg, emit: emit, store: store}, prs: prs, notes: notes}
}

func readablePR() *commandtest.PullRequestChecks {
	return &commandtest.PullRequestChecks{Res: &v1.GetPullRequestResponse{PullRequest: &v1.PullRequest{}}}
}

// The GUI's caller as notification.act passes it on: the window's view, no thread.
var appNoThread = command.Context{ActiveView: "thread"}

// view.open.pr --repo-slug with no thread: the pull request's tab of no thread in the current
// space, by the placement the Pull Requests page's rows use (the focused pane), focused for the
// user's call; refused, opening nothing, without a repository or when the gh store cannot read it.
func TestViewOpenPRWithoutThread(t *testing.T) {
	notFound := &commandtest.PullRequestChecks{Err: connect.NewError(connect.CodeNotFound, errors.New("not found"))}
	offline := &commandtest.PullRequestChecks{Err: connect.NewError(connect.CodeUnavailable, errors.New("offline"))}
	tests := []struct {
		name      string
		ctx       command.Context
		args      map[string]string
		prs       *commandtest.PullRequestChecks
		wantFocus bool
		code      connect.Code
		argErr    string
		inMessage string
	}{
		{name: "the CLI outside a thread", ctx: fromCLI, args: map[string]string{"repo-slug": "Acme/Web", "number": "77"}, prs: readablePR(), wantFocus: true,
			inMessage: "(of no thread) in pane p-main of space sp-main (in the focused pane); it has the user's focus; windows=1"},
		{name: "the app with no thread (a notification's button)", ctx: appNoThread, args: map[string]string{"repo-slug": "Acme/Web", "number": "77"}, prs: readablePR(), wantFocus: true},
		{name: "the CLI with --focus=false", ctx: fromCLI, args: map[string]string{"repo-slug": "Acme/Web", "number": "77", "focus": "false"}, prs: readablePR()},
		{name: "--pane", ctx: fromCLI, args: map[string]string{"repo-slug": "Acme/Web", "number": "77", "pane": "p-two"}, prs: readablePR(), wantFocus: true},
		{name: "no thread and no repository", ctx: fromCLI, args: map[string]string{"number": "77"}, prs: readablePR(), argErr: "thread"},
		{name: "not owner/name", ctx: fromCLI, args: map[string]string{"repo-slug": "acme/web/extra", "number": "77"}, prs: readablePR(), argErr: "repo-slug"},
		{name: "an empty --repo-slug", ctx: fromCLI, args: map[string]string{"repo-slug": " ", "number": "77"}, prs: readablePR(), argErr: "repo-slug"},
		{name: "number 0", ctx: fromCLI, args: map[string]string{"repo-slug": "acme/web", "number": "0"}, prs: readablePR(), argErr: "number"},
		{name: "unknown to GitHub", ctx: fromCLI, args: map[string]string{"repo-slug": "acme/web", "number": "99999"}, prs: notFound, code: connect.CodeNotFound},
		{name: "GitHub unreachable", ctx: appNoThread, args: map[string]string{"repo-slug": "acme/web", "number": "77"}, prs: offline, code: connect.CodeUnavailable},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newPRFixture(t, tt.prs)
			before := len(f.store.Ops())
			res, err := f.reg.Invoke(context.Background(), tt.ctx, "view.open.pr", tt.args)
			if checkItemErr(t, err, tt.code, tt.argErr) {
				if len(f.store.Ops()) != before || len(f.tabsOf("pullrequest")) != 0 {
					t.Errorf("a refusal opened a tab: %+v", f.tabsOf("pullrequest"))
				}
				if tt.code == connect.CodeNotFound && !strings.Contains(err.Error(), "no pull request #99999 in acme/web") {
					t.Errorf("err = %v, want it to name the pull request", err)
				}
				return
			}
			prs := f.tabsOf("pullrequest")
			if len(prs) != 1 {
				t.Fatalf("pull request tabs %+v, want one", prs)
			}
			tb := prs[0]
			want := map[string]string{"slug": tt.args["repo-slug"], "number": tt.args["number"]}
			if tb.Thread != "" || !maps.Equal(tb.Params, want) || tb.Key != "pr:acme/web#77" || tb.Title != "#77" {
				t.Errorf("tab = %+v, want one of no thread showing %v", tb, want)
			}
			sp, p, _ := f.state().FindTab(tb.ID)
			wantPane := "p-main"
			if tt.args["pane"] != "" {
				wantPane = tt.args["pane"]
			}
			if p.ID != wantPane || (wantPane == "p-main" && sp.ID != "sp-main") {
				t.Errorf("tab in %s/%s, want pane %s", sp.ID, p.ID, wantPane)
			}
			wantAt := "sp-main/p-main/t-a"
			if tt.wantFocus {
				wantAt = sp.ID + "/" + p.ID + "/" + tb.ID
			}
			if got := f.focus(); got != wantAt {
				t.Errorf("focus = %s, want %s", got, wantAt)
			}
			out := res.JSON.(command.PanelResult)
			if out.Thread != "" || out.TabThread != "" || out.Tab != tb.ID || out.TabFocused != tt.wantFocus || out.ThreadNotOpen {
				t.Errorf("JSON = %+v", out)
			}
			if tt.ctx.ActiveView != "" && res.Message != "" {
				t.Errorf("message in the app = %q, want none", res.Message)
			}
			if tt.inMessage != "" && !strings.Contains(res.Message, tt.inMessage) {
				t.Errorf("message = %q, want it to contain %q", res.Message, tt.inMessage)
			}
			sameIntents(t, f.emit.Intents(), nil)
		})
	}
}

// A pull request's tab is one per space whatever opened it: the command's for the same pull
// request (however the slug is spelled) is the tab the Pull Requests page's row opened (the
// GUI's open_surface: no thread, params slug and number), or the one a thread opened, used
// where it is and brought forward.
func TestViewOpenPRIsOneTab(t *testing.T) {
	// The page row's open, as gui/frontend/src/shell/hostShell.ts shellOpenTab sends it.
	pageRow := func(t *testing.T, f prFixture) string {
		t.Helper()
		c, err := f.store.Apply(context.Background(), &core.OpenSurface{Tab: &core.Tab{Kind: "pullrequest", Title: "#77",
			Params: map[string]string{"slug": "acme/web", "number": "77"}}, Focus: true}, layoutstore.ApplyOptions{})
		if err != nil {
			t.Fatal(err)
		}
		f.run(t, fromCLI, "tab.focus", map[string]string{"tab": "t-a"})
		return c.Result.Tab
	}
	byThread := func(t *testing.T, f prFixture) string {
		t.Helper()
		return f.run(t, selfCLI, "view.open.pr", map[string]string{"number": "77", "repo-slug": "acme/web"}).JSON.(command.PanelResult).Tab
	}
	byCommand := func(t *testing.T, f prFixture) string {
		t.Helper()
		id := f.run(t, fromCLI, "view.open.pr", map[string]string{"number": "77", "repo-slug": "Acme/Web"}).JSON.(command.PanelResult).Tab
		f.run(t, fromCLI, "tab.focus", map[string]string{"tab": "t-a"})
		return id
	}
	for _, tt := range []struct {
		name       string
		first      func(*testing.T, prFixture) string
		wantThread string
	}{
		{name: "after the page's row", first: pageRow},
		{name: "after a thread's", first: byThread, wantThread: self},
		{name: "after itself", first: byCommand},
	} {
		t.Run(tt.name, func(t *testing.T) {
			f := newPRFixture(t, readablePR())
			first := tt.first(t, f)
			res := f.run(t, appNoThread, "view.open.pr", map[string]string{"number": "77", "repo-slug": "ACME/web", "focus": "true"})
			out := res.JSON.(command.PanelResult)
			if prs := f.tabsOf("pullrequest"); len(prs) != 1 || out.Tab != first || !out.Existing || out.TabThread != tt.wantThread {
				t.Fatalf("tabs %+v, JSON %+v: want the first tab %s, used where it is", prs, out, first)
			}
			sp, p, _ := f.state().FindTab(first)
			if got, want := f.focus(), sp.ID+"/"+p.ID+"/"+first; got != want {
				t.Errorf("focus = %s, want %s", got, want)
			}
		})
	}
	t.Run("from the CLI the message says whose it is", func(t *testing.T) {
		f := newPRFixture(t, readablePR())
		byCommand(t, f)
		if res := f.run(t, fromCLI, "view.open.pr", map[string]string{"number": "77", "repo-slug": "acme/web"}); !strings.Contains(res.Message, "(of no thread) is already open in pane p-main") {
			t.Errorf("message = %q", res.Message)
		}
	})
}

// A GitHub card's Open PR (internal/daemon/github_notifications_rules.go openAction) runs
// view.open.pr itself through notification.act: from the bell (a view, no thread) and from the
// CLI, the pull request's tab of no thread opens focused and the card stays; pressed again, the
// same tab. A pull request the gh store cannot read fails the act and opens nothing.
func TestGitHubNotificationOpensThePRTab(t *testing.T) {
	ctx := context.Background()
	post := func(t *testing.T, f prFixture) string {
		t.Helper()
		res, err := f.notes.Post(ctx, notification.Post{Source: notification.SourceGitHub, Key: "pr/acme/web#77/review-requested", Title: "Review requested",
			Actions: []notification.ActionSpec{{Action: notification.Action{Label: "Open PR", Kind: notification.KindCommand, Command: "view.open.pr",
				Args: map[string]string{"repo-slug": "Acme/web", "number": "77", "focus": "true"}}, Resolves: new(false)}}})
		if err != nil {
			t.Fatal(err)
		}
		return res.Notification.ID
	}
	for _, caller := range []struct {
		name string
		ctx  command.Context
	}{{"the bell", appNoThread}, {"the CLI", fromCLI}, {"a thread's CLI", selfCLI}} {
		t.Run(caller.name, func(t *testing.T) {
			f := newPRFixture(t, readablePR())
			id := post(t, f)
			var tabs []string
			for range 2 {
				res := f.run(t, caller.ctx, "notification.act", map[string]string{"id": id})
				v := res.JSON.(command.NotificationActView)
				tabs = append(tabs, v.Result.(command.PanelResult).Tab)
				if v.Notification.Status != "shown" {
					t.Errorf("status %s, want the card to stay", v.Notification.Status)
				}
				f.run(t, fromCLI, "tab.focus", map[string]string{"tab": "t-a"})
			}
			prs := f.tabsOf("pullrequest")
			if len(prs) != 1 || prs[0].Thread != "" || tabs[0] != prs[0].ID || tabs[1] != prs[0].ID {
				t.Fatalf("tabs %+v, results %v: want one tab of no thread", prs, tabs)
			}
		})
	}
	t.Run("focused", func(t *testing.T) {
		f := newPRFixture(t, readablePR())
		res := f.run(t, appNoThread, "notification.act", map[string]string{"id": post(t, f)})
		tab := res.JSON.(command.NotificationActView).Result.(command.PanelResult).Tab
		if got := f.focus(); got != "sp-main/p-main/"+tab {
			t.Errorf("focus = %s, want the pull request's tab", got)
		}
	})
	t.Run("unreadable", func(t *testing.T) {
		f := newPRFixture(t, &commandtest.PullRequestChecks{Err: connect.NewError(connect.CodeNotFound, errors.New("not found"))})
		id := post(t, f)
		if _, err := f.reg.Invoke(ctx, appNoThread, "notification.act", map[string]string{"id": id}); err == nil || !strings.Contains(err.Error(), "no pull request #77") {
			t.Errorf("err = %v, want the pull request named", err)
		}
		if n, _ := f.notes.Get(id); n.Status() != notification.StatusShown || len(f.tabsOf("pullrequest")) != 0 {
			t.Errorf("status %s, tabs %+v: want the card shown and no tab", n.Status(), f.tabsOf("pullrequest"))
		}
	})
}
