package daemon_test

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	ghostty "go.mitchellh.com/libghostty"

	v1 "github.com/awaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/awaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/awaumann/code-foundry/internal/client"
	"github.com/awaumann/code-foundry/internal/paths"
)

// TestSessionDriver is a manual end-to-end helper against a running daemon (see
// docs/notes/phase2a-session.md). It is skipped unless CF_DRIVE_HOME is set.
//
//	CF_DRIVE_HOME=/tmp/cf2a-home CF_DRIVE_SESSION=s-... CF_DRIVE_STEP=screen|write|watch [CF_DRIVE_TEXT=...]
//
// screen attaches over the loopback listener (like the GUI), renders the snapshot in
// a libghostty terminal, and prints the plain text. write types CF_DRIVE_TEXT, waits,
// then sends Enter. watch prints session events for CF_DRIVE_SECONDS.
func TestSessionDriver(t *testing.T) {
	home := os.Getenv("CF_DRIVE_HOME")
	if home == "" {
		t.Skip("CF_DRIVE_HOME not set")
	}
	ep, err := client.ReadEndpoint(paths.New(home))
	if err != nil {
		t.Fatal(err)
	}
	var protocols http.Protocols
	protocols.SetUnencryptedHTTP2(true)
	hc := &http.Client{Transport: bearer{token: ep.Token, next: &http.Transport{
		Protocols: &protocols, DialContext: (&net.Dialer{}).DialContext,
	}}}
	sessions := codefoundryv1connect.NewSessionServiceClient(hc, ep.BaseURL)
	terms := codefoundryv1connect.NewTerminalServiceClient(hc, ep.BaseURL)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	id := os.Getenv("CF_DRIVE_SESSION")
	get := func() *v1.Session {
		res, err := sessions.Get(ctx, connect.NewRequest(&v1.GetSessionRequest{Id: id}))
		if err != nil {
			t.Fatal(err)
		}
		return res.Msg.GetSession()
	}
	switch os.Getenv("CF_DRIVE_STEP") {
	case "screen":
		s := get()
		start := time.Now()
		stream, err := terms.Attach(ctx, connect.NewRequest(&v1.AttachRequest{Id: s.GetTerminalId()}))
		if err != nil {
			t.Fatal(err)
		}
		if !stream.Receive() {
			t.Fatal(stream.Err())
		}
		snap := stream.Msg().GetSnapshot()
		fmt.Printf("attach snapshot: %d bytes, %dx%d alt=%v in %v\n", len(snap.GetData()), snap.GetCols(), snap.GetRows(),
			snap.GetAltScreen(), time.Since(start).Round(time.Millisecond))
		fmt.Println(render(t, snap.GetData(), uint16(snap.GetCols()), uint16(snap.GetRows())))
		_ = stream.Close()
	case "write":
		s := get()
		text := os.Getenv("CF_DRIVE_TEXT")
		if _, err := terms.Write(ctx, connect.NewRequest(&v1.WriteTerminalRequest{Id: s.GetTerminalId(), Data: []byte(text)})); err != nil {
			t.Fatal(err)
		}
		time.Sleep(300 * time.Millisecond)
		if _, err := terms.Write(ctx, connect.NewRequest(&v1.WriteTerminalRequest{Id: s.GetTerminalId(), Data: []byte("\r")})); err != nil {
			t.Fatal(err)
		}
		fmt.Printf("wrote %q + Enter to %s at %s\n", text, s.GetTerminalId(), time.Now().Format("15:04:05.000"))
	case "watch":
		secs := 10 * time.Second
		if v := os.Getenv("CF_DRIVE_SECONDS"); v != "" {
			d, _ := time.ParseDuration(v + "s")
			secs = d
		}
		wctx, wcancel := context.WithTimeout(ctx, secs)
		defer wcancel()
		stream, err := sessions.Watch(wctx, connect.NewRequest(&v1.WatchSessionsRequest{}))
		if err != nil {
			t.Fatal(err)
		}
		start := time.Now()
		for stream.Receive() {
			ev := stream.Msg()
			if u := ev.GetUpdated(); u != nil && (id == "" || u.GetId() == id) {
				fmt.Printf("+%6dms %s state=%s status=%s name=%q claude=%s reason=%q err=%q\n", time.Since(start).Milliseconds(),
					u.GetId(), u.GetState(), u.GetStatus(), u.GetName(), u.GetClaudeSessionId(), u.GetDisconnectReason(), u.GetLastError())
			}
		}
	default:
		t.Fatal("CF_DRIVE_STEP must be screen, write, or watch")
	}
}

// render replays a snapshot into a fresh libghostty terminal and returns plain text.
func render(t *testing.T, data []byte, cols, rows uint16) string {
	t.Helper()
	term, err := ghostty.NewTerminal(ghostty.WithSize(cols, rows), ghostty.WithMaxScrollbackBytes(64<<20))
	if err != nil {
		t.Fatal(err)
	}
	defer term.Close()
	term.VTWrite(data)
	f, err := ghostty.NewFormatter(term, ghostty.WithFormatterFormat(ghostty.FormatterFormatPlain), ghostty.WithFormatterTrim(true))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	out, err := f.FormatString()
	if err != nil {
		t.Fatal(err)
	}
	var lines []string
	for _, l := range strings.Split(out, "\n") {
		if strings.TrimSpace(l) != "" {
			lines = append(lines, l)
		}
	}
	return strings.Join(lines, "\n")
}
