package command

import (
	"context"
	"errors"
	"strings"
	"testing"

	"connectrpc.com/connect"
)

func TestResolveID(t *testing.T) {
	ids := []string{"s-7754a478e649", "s-867564981c98", "s-00000000e649", "s-abcdef123456"}
	tests := []struct {
		name, ref string
		kind      IDKind
		want      string
		code      connect.Code // 0: no connect error
		wantArg   string       // substring of an *ArgError
	}{
		{name: "full id", ref: "s-7754a478e649", kind: ThreadID, want: "s-7754a478e649"},
		{name: "full id not listed passes through", ref: "s-nope", kind: ThreadID, want: "s-nope"},
		{name: "unique suffix", ref: "a478e649", kind: ThreadID, want: "s-7754a478e649"},
		{name: "four characters", ref: "1c98", kind: ThreadID, want: "s-867564981c98"},
		{name: "the hex part whole", ref: "abcdef123456", kind: ThreadID, want: "s-abcdef123456"},
		{name: "short values pass through", ref: "e64", kind: ThreadID, want: "e64"},
		{name: "ambiguous", ref: "e649", kind: ThreadID, wantArg: `"e649" is ambiguous: 2 thread ids end in it (s-00000000e649, s-7754a478e649)`},
		{name: "none", ref: "ffff", kind: ThreadID, code: connect.CodeNotFound},
		{name: "a prefix is not a suffix", ref: "7754", kind: ThreadID, code: connect.CodeNotFound},
		{name: "listed exactly without the prefix", ref: "user", kind: ThreadID, code: connect.CodeNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ResolveID(tt.kind, "id", tt.ref, ids)
			var ce *connect.Error
			var ae *ArgError
			switch {
			case tt.code != 0:
				if !errors.As(err, &ce) || ce.Code() != tt.code {
					t.Fatalf("ResolveID = %q, %v; want code %v", got, err, tt.code)
				}
			case tt.wantArg != "":
				if !errors.As(err, &ae) || !strings.Contains(ae.Msg, tt.wantArg) || ae.Arg != "id" {
					t.Fatalf("ResolveID = %q, %v; want an arg error with %q", got, err, tt.wantArg)
				}
			case err != nil || got != tt.want:
				t.Fatalf("ResolveID = %q, %v; want %q", got, err, tt.want)
			}
		})
	}
}

func TestInvokeResolvesIDs(t *testing.T) {
	var gotArgs Args
	var gotCtx Context
	run := func(_ context.Context, c Context, a Args) (Result, error) {
		gotArgs, gotCtx = a, c
		return Result{}, nil
	}
	newReg := func(list IDLister) *Registry {
		r := NewRegistry()
		if list != nil {
			r.SetIDLister(ThreadID, list)
		}
		if err := r.Register(Command{Name: "test.thread", Title: "T", Category: "Test", Run: run, Args: []ArgSpec{
			{Name: "id", Type: String, Required: true, Context: ContextThread, ID: ThreadID},
			{Name: "other", Type: String, ID: ThreadID},
			{Name: "run", Type: String, ID: RunID},
		}}); err != nil {
			t.Fatal(err)
		}
		return r
	}
	calls := 0
	list := func(context.Context) ([]string, error) {
		calls++
		return []string{"s-7754a478e649", "s-867564981c98"}, nil
	}
	r := newReg(list)
	if _, err := r.Invoke(context.Background(), Context{}, "test.thread", map[string]string{"id": "e649", "other": "1c98", "run": "abcd"}); err != nil {
		t.Fatal(err)
	}
	if gotArgs.String("id") != "s-7754a478e649" || gotArgs.String("other") != "s-867564981c98" || gotCtx.ActiveThreadID != "s-7754a478e649" {
		t.Errorf("resolved id=%q other=%q context=%q", gotArgs.String("id"), gotArgs.String("other"), gotCtx.ActiveThreadID)
	}
	if gotArgs.String("run") != "abcd" {
		t.Errorf("a kind without a lister: run = %q, want it as given", gotArgs.String("run"))
	}
	calls = 0
	if _, err := r.Invoke(context.Background(), Context{ActiveThreadID: "s-867564981c98"}, "test.thread", nil); err != nil || calls != 0 {
		t.Errorf("a full id from the context: err %v, %d lists (want none)", err, calls)
	}
	if gotArgs.String("id") != "s-867564981c98" {
		t.Errorf("context id = %q", gotArgs.String("id"))
	}
	_, err := r.Invoke(context.Background(), Context{}, "test.thread", map[string]string{"id": "ffff"})
	if connect.CodeOf(err) != connect.CodeNotFound || !strings.Contains(err.Error(), `no thread id ends in "ffff"`) {
		t.Errorf("unknown suffix: %v", err)
	}
	failing := newReg(func(context.Context) ([]string, error) { return nil, errors.New("daemon down") })
	if _, err := failing.Invoke(context.Background(), Context{}, "test.thread", map[string]string{"id": "e649"}); err == nil || !strings.Contains(err.Error(), "daemon down") {
		t.Errorf("lister error: %v", err)
	}
	if _, err := newReg(nil).Invoke(context.Background(), Context{}, "test.thread", map[string]string{"id": "e649"}); err != nil || gotArgs.String("id") != "e649" {
		t.Errorf("no lister: %v, id %q", err, gotArgs.String("id"))
	}
}

func TestIDArgValidation(t *testing.T) {
	for _, s := range []ArgSpec{{Name: "id", Type: Int, ID: ThreadID}, {Name: "id", Type: String, ID: IDKind(99)}} {
		if err := s.validate(); err == nil {
			t.Errorf("%+v: no error", s)
		}
	}
	if err := (ArgSpec{Name: "id", Type: String, ID: SubscriptionID}).validate(); err != nil {
		t.Error(err)
	}
}
