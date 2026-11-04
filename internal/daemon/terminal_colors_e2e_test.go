package daemon_test

import (
	"context"
	"net"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/client"
	"github.com/alexwaumann/code-foundry/internal/daemon"
	"github.com/alexwaumann/code-foundry/internal/paths"
	"github.com/alexwaumann/code-foundry/internal/theme"
	"github.com/alexwaumann/code-foundry/internal/version"
)

// askBackground asks for the background in raw mode and prints the reply hex-escaped.
const askBackground = `stty raw -echo; printf '\033]11;?\033\\'; r=$(dd bs=1 count=25 2>/dev/null | od -An -c | tr -d ' \n'); stty sane; printf '\r\nREPLY:%s\r\n' "$r"`

// xterm leaves color queries to the daemon, so the daemon must have colors from the
// moment it starts, and then the GUI's.
func TestTerminalsAnswerColorQueriesFromTheTheme(t *testing.T) {
	home, err := os.MkdirTemp("/tmp", "cf-colors-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	p := paths.New(home)
	ctx, stop := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- daemon.Run(ctx, daemon.Options{Paths: p, Version: version.Info{Version: "test"}}) }()
	t.Cleanup(func() {
		stop()
		<-done
	})

	var ep client.Endpoint
	for i := 0; ; i++ {
		if ep, err = client.ReadEndpoint(p); err == nil {
			break
		}
		if i > 2400 { // a daemon start under the race detector takes seconds
			t.Fatalf("daemon did not start: %v", err)
		}
		time.Sleep(25 * time.Millisecond)
	}
	var protocols http.Protocols
	protocols.SetUnencryptedHTTP2(true)
	hc := &http.Client{Transport: bearer{token: ep.Token, next: &http.Transport{
		Protocols: &protocols, DialContext: (&net.Dialer{}).DialContext,
	}}}
	terminals := codefoundryv1connect.NewTerminalServiceClient(hc, ep.BaseURL)
	ui := codefoundryv1connect.NewUiServiceClient(hc, ep.BaseURL)

	cctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	reply := func() string {
		t.Helper()
		created, err := terminals.Create(cctx, connect.NewRequest(&v1.CreateTerminalRequest{
			Argv: []string{"/bin/sh", "-c", askBackground}, Cwd: home, Cols: 80, Rows: 5,
		}))
		if err != nil {
			t.Fatal(err)
		}
		stream, err := terminals.Attach(cctx, connect.NewRequest(&v1.AttachRequest{Id: created.Msg.GetTerminal().GetId()}))
		if err != nil {
			t.Fatal(err)
		}
		defer stream.Close()
		var out strings.Builder
		for stream.Receive() {
			out.Write(stream.Msg().GetSnapshot().GetData())
			out.Write(stream.Msg().GetOutput().GetData())
			if stream.Msg().GetExited() != nil {
				return out.String()
			}
		}
		t.Fatalf("attach ended before the exit: %v; output %q", stream.Err(), out.String())
		return ""
	}

	// Nothing published: the default dark theme's surface, #0d1117.
	if got, want := reply(), "REPLY:033]11;rgb:0d0d/1111/1717033\\"; !strings.Contains(got, want) {
		t.Errorf("before a publish: want %q in %q", want, got)
	}

	f := theme.DefaultFrame(theme.SchemeDark)
	f.Vars["--cf-surface"] = "#21252b"
	if _, err := ui.PublishTheme(cctx, connect.NewRequest(&v1.PublishThemeRequest{Id: "atom-one-dark", Scheme: f.Scheme, Vars: f.Vars})); err != nil {
		t.Fatal(err)
	}
	if got, want := reply(), "REPLY:033]11;rgb:2121/2525/2b2b033\\"; !strings.Contains(got, want) {
		t.Errorf("after a publish: want %q in %q", want, got)
	}
}
