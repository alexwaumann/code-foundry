package command_test

import (
	"context"
	"reflect"
	"slices"
	"strings"
	"testing"

	"connectrpc.com/connect"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/store/page"
	"github.com/alexwaumann/code-foundry/internal/store/page/pagetest"
)

func pageRegistry(t *testing.T, b command.PageBackend) *command.Registry {
	t.Helper()
	reg := command.NewRegistry()
	if err := command.RegisterPage(reg, b); err != nil {
		t.Fatal(err)
	}
	return reg
}

// page.get says who owns a page and the user's answer; page.allow and page.disallow change
// the answer both ways, from the app or the CLI, and never from a page's own script.
func TestPageCommands(t *testing.T) {
	ctx := context.Background()
	b := &pagetest.Backend{Pages: map[string]page.Access{
		"/h/owned.html": {Path: "/h/owned.html", Owner: "t-1", Owners: []page.Owner{{Thread: "t-1", How: page.Written}}},
		"/h/dir.html":   {Path: "/h/dir.html", Owner: "t-2", PagesThread: "t-2", Owners: []page.Owner{{Thread: "t-2", How: page.PagesDirectory}}},
		"/h/many.html": {Path: "/h/many.html", Owner: "t-2", PagesThread: "t-2",
			Owners: []page.Owner{{Thread: "t-2", How: page.PagesDirectory}, {Thread: "t-1", How: page.Shown}}},
		"/h/new.html": {Path: "/h/new.html"},
	}}
	reg := pageRegistry(t, b)
	app, cli, pg := command.Context{ActiveView: "thread"}, command.Context{Origin: command.OriginCLI}, command.Context{Origin: command.OriginPage, ActiveThreadID: "t-1"}
	unknown := command.Context{Origin: command.OriginUnknown} // internal/api's callerContext for a call with neither
	for _, tt := range []struct {
		name    string
		uctx    command.Context
		verb    string
		path    string
		want    command.PageView
		wantMsg string
		code    connect.Code
	}{
		{name: "an owned page", uctx: cli, verb: "page.get", path: "/h/owned.html",
			want:    command.PageView{Path: "/h/owned.html", OwnerThread: "t-1", OwnerSource: "written", Owners: owners("t-1", "written"), Consent: "owned", Answer: "not-asked"},
			wantMsg: "owner: thread t-1 (it wrote the page)"},
		{name: "a pages directory's", uctx: cli, verb: "page.get", path: "/h/dir.html",
			want: command.PageView{Path: "/h/dir.html", OwnerThread: "t-2", OwnerSource: "pages-directory", Owners: owners("t-2", "pages-directory"), Consent: "owned", Answer: "not-asked"}},
		{name: "many owners", uctx: cli, verb: "page.get", path: "/h/many.html",
			want: command.PageView{Path: "/h/many.html", OwnerThread: "t-2", OwnerSource: "pages-directory",
				Owners: owners("t-2", "pages-directory", "t-1", "shown"), Consent: "owned", Answer: "not-asked"},
			wantMsg: "owners: thread t-2 (its pages directory), thread t-1 (it showed the page): a view of one of them acts for that thread, any other for t-2"},
		{name: "not asked", uctx: app, verb: "page.get", path: "/h/new.html",
			want: command.PageView{Path: "/h/new.html", Consent: "not-asked", Answer: "not-asked"}, wantMsg: "answer: not asked: the page gets no bridge"},
		{name: "a page may read it", uctx: pg, verb: "page.get", path: "/h/new.html",
			want: command.PageView{Path: "/h/new.html", Consent: "not-asked", Answer: "not-asked"}},
		{name: "allow", uctx: app, verb: "page.allow", path: "/h/new.html",
			want: command.PageView{Path: "/h/new.html", Consent: "allowed", Answer: "allowed"}, wantMsg: "the bridge without a thread"},
		{name: "stop allowing", uctx: cli, verb: "page.disallow", path: "/h/new.html",
			want: command.PageView{Path: "/h/new.html", Consent: "refused", Answer: "refused"}},
		{name: "allow after refusing", uctx: cli, verb: "page.allow", path: "/h/new.html",
			want: command.PageView{Path: "/h/new.html", Consent: "allowed", Answer: "allowed"}},
		{name: "an owned page keeps the answer for later", uctx: app, verb: "page.disallow", path: "/h/owned.html",
			want:    command.PageView{Path: "/h/owned.html", OwnerThread: "t-1", OwnerSource: "written", Owners: owners("t-1", "written"), Consent: "owned", Answer: "refused"},
			wantMsg: "counts once no thread owns the page"},
		{name: "a page cannot allow itself", uctx: pg, verb: "page.allow", path: "/h/new.html", code: connect.CodePermissionDenied},
		{name: "nor stop another", uctx: pg, verb: "page.disallow", path: "/h/new.html", code: connect.CodePermissionDenied},
		{name: "a caller that names no origin nor view cannot allow", uctx: unknown, verb: "page.allow", path: "/h/new.html", code: connect.CodePermissionDenied},
		{name: "nor stop allowing", uctx: unknown, verb: "page.disallow", path: "/h/new.html", code: connect.CodePermissionDenied},
		{name: "but may read", uctx: unknown, verb: "page.get", path: "/h/new.html",
			want: command.PageView{Path: "/h/new.html", Consent: "allowed", Answer: "allowed"}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			res, err := reg.Invoke(ctx, tt.uctx, tt.verb, map[string]string{"path": tt.path})
			if tt.code != 0 {
				if connect.CodeOf(err) != tt.code {
					t.Fatalf("err = %v, want %v", err, tt.code)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			want := tt.want
			if want.Owners == nil {
				want.Owners = []command.PageOwnerView{}
			}
			if got, _ := res.JSON.(command.PageView); !reflect.DeepEqual(got, want) {
				t.Errorf("JSON = %+v, want %+v", got, tt.want)
			}
			if !strings.Contains(res.Message, tt.wantMsg) || !strings.HasPrefix(res.Message, tt.path+"\n") {
				t.Errorf("message = %q, want it to hold %q", res.Message, tt.wantMsg)
			}
		})
	}
	// The page's script left the answer as the last allowed one.
	if a, _ := b.Access(ctx, "/h/new.html"); a.Consent != page.Allowed {
		t.Errorf("after the page's calls: %v", a.Consent)
	}
}

// owners are PageView owners from thread, source pairs.
func owners(pairs ...string) []command.PageOwnerView {
	out := []command.PageOwnerView{}
	for i := 0; i+1 < len(pairs); i += 2 {
		out = append(out, command.PageOwnerView{Thread: pairs[i], Source: pairs[i+1]})
	}
	return out
}

func TestPageCommandErrors(t *testing.T) {
	ctx := context.Background()
	for _, tt := range []struct {
		err  error
		code connect.Code
	}{
		{page.ErrInvalidArgument, connect.CodeInvalidArgument},
		{page.ErrNotFound, connect.CodeNotFound},
		{page.ErrGuarded, connect.CodePermissionDenied},
	} {
		reg := pageRegistry(t, &pagetest.Backend{Err: tt.err})
		for _, verb := range []string{"page.get", "page.allow", "page.disallow"} {
			if _, err := reg.Invoke(ctx, command.Context{}, verb, map[string]string{"path": "/h/x.html"}); connect.CodeOf(err) != tt.code {
				t.Errorf("%s with %v: %v, want %v", verb, tt.err, err, tt.code)
			}
		}
	}
	reg := pageRegistry(t, nil)
	if _, err := reg.Invoke(ctx, command.Context{}, "page.get", map[string]string{"path": "/h/x.html"}); connect.CodeOf(err) != connect.CodeUnimplemented {
		t.Errorf("no backend: %v", err)
	}
}

// view.open.page records the thread as the page's owner once the tab opens; a refused call
// records nothing.
func TestPanelPageRecordsTheOwner(t *testing.T) {
	type shown struct{ thread, path string }
	var got []shown
	d := panelDeps{windows: 1, files: &commandtest.Files{Files: []string{"/wt/p.html", "/wt/main.go"}},
		pageShown: func(_ context.Context, id, path string) { got = append(got, shown{id, path}) }}
	reg, _ := panelRegistryWith(t, &commandtest.Thread{Current: richThread()}, d)
	inThread := command.Context{ActiveThreadID: "s-aaaaaaaaaaa1"}
	if _, err := reg.Invoke(context.Background(), inThread, "view.open.page", map[string]string{"path": "/wt/p.html"}); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.Invoke(context.Background(), inThread, "view.open.page", map[string]string{"path": "/wt/main.go"}); err == nil {
		t.Fatal("a .go file opened as a page")
	}
	if _, err := reg.Invoke(context.Background(), inThread, "view.open.page", map[string]string{"path": "/wt/gone.html"}); err == nil {
		t.Fatal("a missing page opened")
	}
	if want := []shown{{"s-aaaaaaaaaaa1", "/wt/p.html"}}; !slices.Equal(got, want) {
		t.Errorf("recorded %v, want %v", got, want)
	}
}
