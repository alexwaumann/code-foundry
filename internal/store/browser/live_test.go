package browser

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// These run the real system Chrome against pages served from this test, never the network.
// They skip on a Mac without Chrome, and in CI: a runner has Chrome, and is starved enough that
// a page can take 15 s to load, so they would only make it red at random. `make check` runs them.

const livePage = `<!doctype html><title>Live page</title>
<body style="margin:0;font:16px system-ui;height:3000px">
<select id=s style="position:fixed;left:20px;top:20px;width:200px;height:30px"><option>one<option>two<option disabled>three<option>four</select>
<textarea id=t style="position:fixed;left:20px;top:80px;width:300px;height:100px"></textarea>
<a id=blank href="/two" target=_blank style="position:fixed;left:20px;top:200px">blank</a>
<button id=pop onclick="window.w=window.open('/two','x','width=300,height=300')" style="position:fixed;left:120px;top:200px">pop</button>
<input id=f type=file style="position:fixed;left:20px;top:240px">
<a id=dl href="/dl" style="position:fixed;left:20px;top:280px">dl</a>
<button id=copy onclick="navigator.clipboard.writeText('from a button')" style="position:fixed;left:120px;top:280px">copy</button>
<script>
window.log=[]; window.clicks=0; window.scrolls=0;
s.onchange=()=>log.push('change '+s.value);
addEventListener('click',()=>clicks++);
addEventListener('scroll',()=>scrolls++);
addEventListener('paste',e=>log.push('paste '+e.clipboardData.getData('text/plain')));
</script>`

type live struct {
	t     *testing.T
	s     *Store
	srv   *httptest.Server
	v     *Viewer
	key   string
	mu    sync.Mutex
	state State
	bytes atomic.Int64
	count atomic.Int64
	last  atomic.Pointer[Frame]
	// copied stands in for the Mac's clipboard, which a test must never touch.
	copied atomic.Value
}

func startLive(t *testing.T) *live {
	t.Helper()
	if testing.Short() || os.Getenv("CI") != "" {
		t.Skip("needs system Chrome and a machine that is not starved")
	}
	home, _ := os.UserHomeDir()
	if _, err := FindChrome(home); err != nil {
		t.Skip("no system Chrome")
	}
	mux := http.NewServeMux()
	html := func(body string) http.HandlerFunc {
		return func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprint(w, body)
		}
	}
	mux.HandleFunc("/", html(livePage))
	mux.HandleFunc("/two", html(`<title>Two</title><body>second page`))
	mux.HandleFunc("/dl", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Disposition", `attachment; filename="report.txt"`)
		fmt.Fprint(w, "data")
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	// A short path: Chrome's singleton socket does not fit under t.TempDir on macOS.
	dir, err := os.MkdirTemp("", "cfb")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	l := &live{t: t, srv: srv, key: "thread:live"}
	l.copied.Store("")
	s := New(Options{
		SetClipboard: func(_ context.Context, text string) error {
			l.copied.Store(text)
			return nil
		},
		Dir: dir, Enabled: func() bool { return true }, Idle: time.Hour, Log: liveLog(),
		Launch: ExecLauncher(func() (string, error) { return FindChrome(home) }, slog.New(slog.DiscardHandler)),
		Reveal: func(string) error { return nil },
	})
	t.Cleanup(s.Close)
	l.s = s
	l.watch(srv.URL)
	l.until("the page", func(st State) bool { return st.Title == "Live page" && !st.Loading })
	return l
}

// liveLog shows the store's debug lines with CF_LIVE_LOG set.
func liveLog() *slog.Logger {
	if os.Getenv("CF_LIVE_LOG") == "" {
		return slog.New(slog.DiscardHandler)
	}
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug}))
}

func (l *live) watch(address string) {
	l.t.Helper()
	v, err := l.s.Watch(l.key, 640, 480, address)
	if err != nil {
		l.t.Fatal(err)
	}
	l.v = v
	go func() {
		for range v.Wake() {
			st, f, err := v.Take()
			if st != nil {
				l.mu.Lock()
				l.state = *st
				l.mu.Unlock()
			}
			if f != nil {
				l.count.Add(1)
				l.bytes.Add(int64(len(f.JPEG)))
				l.last.Store(f)
				f.Taken()
			}
			if err != nil {
				return
			}
		}
	}()
}

func (l *live) now() State {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.state
}

func (l *live) until(what string, ok func(State) bool) State {
	l.t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if st := l.now(); ok(st) {
			return st
		}
		time.Sleep(10 * time.Millisecond)
	}
	l.t.Fatalf("waiting for %s: %+v", what, l.now())
	return State{}
}

func (l *live) eval(expr string, out any) {
	l.t.Helper()
	in, _, t, err := l.s.shown(l.key)
	if err != nil {
		l.t.Fatal(err)
	}
	if err := evaluate(context.Background(), in, t.session, expr, out); err != nil {
		l.t.Fatal(err)
	}
}

func (l *live) evalUntil(expr string, ok func(string) bool) string {
	l.t.Helper()
	var got string
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		l.eval(expr, &got)
		if ok(got) {
			return got
		}
	}
	l.t.Fatalf("%s stayed %q", expr, got)
	return got
}

func (l *live) click(x, y float64) {
	l.t.Helper()
	err := l.s.Input(context.Background(), l.key, []InputEvent{
		{Mouse: &MouseEvent{Type: "mousePressed", Button: "left", X: x, Y: y, Buttons: 1, ClickCount: 1}},
		{Mouse: &MouseEvent{Type: "mouseReleased", Button: "left", X: x, Y: y, ClickCount: 1}},
	})
	if err != nil {
		l.t.Fatal(err)
	}
}

func (l *live) press(key, code string, keyCode, mods int) {
	l.t.Helper()
	err := l.s.Input(context.Background(), l.key, []InputEvent{
		{Key: &KeyEvent{Type: "rawKeyDown", Key: key, Code: code, KeyCode: keyCode, Modifiers: mods}},
		{Key: &KeyEvent{Type: "keyUp", Key: key, Code: code, KeyCode: keyCode, Modifiers: mods}},
	})
	if err != nil {
		l.t.Fatal(err)
	}
}

func (l *live) typeText(s string) {
	l.t.Helper()
	for _, r := range s {
		c := string(r)
		err := l.s.Input(context.Background(), l.key, []InputEvent{
			{Key: &KeyEvent{Type: "keyDown", Key: c, Text: c}},
			{Key: &KeyEvent{Type: "keyUp", Key: c}},
		})
		if err != nil {
			l.t.Fatal(err)
		}
	}
}

// TestLive runs on one Chrome: each launch of it costs seconds, and many at once starve each
// other. Every case starts from a fresh load of the page.
func TestLive(t *testing.T) {
	l := startLive(t)
	for i, tt := range []struct {
		name string
		run  func(*testing.T, *live)
	}{
		{"InputReachesThePage", liveInputReachesThePage},
		{"ResizeReflowsAndCasts", liveResizeReflowsAndCasts},
		{"NoFramesOnAStillPageAndNoneOnceHidden", liveNoFramesOnAStillPageAndNoneOnceHidden},
		{"FramesSurviveAMoveToAnotherSite", liveFramesSurviveAMoveToAnotherSite},
		{"ADeadAddressSaysSo", liveADeadAddressSaysSo},
		{"DraggingSelectsText", liveDraggingSelectsText},
		{"SelectIsDrawnByTheGUI", liveSelectIsDrawnByTheGUI},
		{"DialogsAskTheViewer", liveDialogsAskTheViewer},
		{"NewWindowsLandInTheSurfaceAndCloseBack", liveNewWindowsLandInTheSurfaceAndCloseBack},
		{"WindowCloseComesBackToTheOpener", liveWindowCloseComesBackToTheOpener},
		{"AddressRuleHolds", liveAddressRuleHolds},
		{"FileChooserAndDownload", liveFileChooserAndDownload},
		{"ClipboardStaysInChromeUntilTheUserMovesIt", liveClipboardStaysInChromeUntilTheUserMovesIt},
	} {
		t.Run(tt.name, func(t *testing.T) {
			l.t = t
			u := fmt.Sprintf("%s/?case=%d", l.srv.URL, i)
			if _, err := l.s.Navigate(context.Background(), l.key, u); err != nil {
				t.Fatal(err)
			}
			l.until("a fresh page", func(st State) bool { return st.URL == u && st.Title == "Live page" && !st.Loading && !st.Popup })
			tt.run(t, l)
		})
	}
}

func eq(want string) func(string) bool { return func(got string) bool { return got == want } }

func liveInputReachesThePage(t *testing.T, l *live) {
	ctx := context.Background()

	l.click(300, 400)
	l.evalUntil("String(clicks)", eq("1"))

	l.click(100, 120)
	l.typeText("hello")
	l.evalUntil("t.value", eq("hello"))
	l.press("Backspace", "Backspace", 8, 0)
	l.evalUntil("t.value", eq("hell"))
	// Plain keys work by themselves; these two need the editing commands of keys.go.
	l.press("a", "KeyA", 65, modMeta)
	l.evalUntil("String(t.selectionEnd-t.selectionStart)", eq("4"))
	l.press("Backspace", "Backspace", 8, modAlt)
	l.evalUntil("t.value", eq(""))

	err := l.s.Input(ctx, l.key, []InputEvent{{Mouse: &MouseEvent{Type: "mouseWheel", Button: "none", X: 300, Y: 400, DeltaY: 300}}})
	if err != nil {
		t.Fatal(err)
	}
	l.evalUntil("String(scrollY>0)", eq("true"))
}

func liveResizeReflowsAndCasts(t *testing.T, l *live) {
	if err := l.s.Resize(context.Background(), l.key, 500, 300); err != nil {
		t.Fatal(err)
	}
	l.evalUntil("innerWidth+'x'+innerHeight+'@'+devicePixelRatio", eq("500x300@2"))
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		if f := l.last.Load(); f != nil && f.Width == 500 && f.Height == 300 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("no 500x300 frame: %+v", l.last.Load())
		}
	}
}

func liveNoFramesOnAStillPageAndNoneOnceHidden(t *testing.T, l *live) {
	time.Sleep(600 * time.Millisecond)
	before := l.count.Load()
	if before == 0 {
		t.Fatal("no frame at all")
	}
	time.Sleep(500 * time.Millisecond)
	if n := l.count.Load() - before; n > 1 {
		t.Fatalf("a still page sent %d frames", n)
	}
	// Moving the page must paint, or the frames were never live.
	l.eval(`document.body.style.background="red"`, nil)
	for deadline := time.Now().Add(5 * time.Second); l.count.Load() == before; time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("a change sent no frame")
		}
	}
	l.v.Close()
	time.Sleep(200 * time.Millisecond)
	stopped := l.count.Load()
	l.eval(`document.body.style.background="blue"`, nil)
	time.Sleep(300 * time.Millisecond)
	if n := l.count.Load() - stopped; n != 0 {
		t.Fatalf("%d frames after the last view left", n)
	}
	l.watch("")
	l.until("the view back", func(st State) bool { return st.Phase == PhaseReady })
	if l.count.Load() == stopped {
		// A new view gets the last frame at once, even on a still page.
		time.Sleep(200 * time.Millisecond)
		if l.count.Load() == stopped {
			t.Fatal("a returning view got no frame")
		}
	}
}

func liveADeadAddressSaysSo(t *testing.T, l *live) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	dead := "http://" + ln.Addr().String() + "/"
	_ = ln.Close()
	if _, err := l.s.Navigate(context.Background(), l.key, dead); err != nil {
		t.Fatal(err)
	}
	st := l.until("the notice", func(st State) bool { return st.Notice != "" })
	if !strings.Contains(st.Notice, "ERR_CONNECTION_REFUSED") {
		t.Fatalf("notice %q", st.Notice)
	}
	// And the next page clears it.
	if _, err := l.s.Navigate(context.Background(), l.key, l.srv.URL+"/two"); err != nil {
		t.Fatal(err)
	}
	l.until("the page", func(st State) bool { return st.Title == "Two" && st.Notice == "" })
}

func liveDraggingSelectsText(t *testing.T, l *live) {
	l.eval(`t.value="select this by dragging";1`, nil)
	err := l.s.Input(context.Background(), l.key, []InputEvent{
		{Mouse: &MouseEvent{Type: "mousePressed", Button: "left", X: 24, Y: 90, Buttons: 1, ClickCount: 1}},
		{Mouse: &MouseEvent{Type: "mouseMoved", Button: "left", X: 90, Y: 90, Buttons: 1}},
		{Mouse: &MouseEvent{Type: "mouseMoved", Button: "left", X: 160, Y: 90, Buttons: 1}},
		{Mouse: &MouseEvent{Type: "mouseReleased", Button: "left", X: 160, Y: 90, ClickCount: 1}},
	})
	if err != nil {
		t.Fatal(err)
	}
	l.evalUntil("String(t.selectionEnd>t.selectionStart)", eq("true"))
}

func liveFramesSurviveAMoveToAnotherSite(t *testing.T, l *live) {
	other := strings.Replace(l.srv.URL, "127.0.0.1", "localhost", 1)
	for _, u := range []string{other + "/two", l.srv.URL + "/two"} {
		before := l.count.Load()
		if _, err := l.s.Navigate(context.Background(), l.key, u); err != nil {
			t.Fatal(err)
		}
		l.until("the page", func(st State) bool { return st.URL == u && !st.Loading })
		for deadline := time.Now().Add(5 * time.Second); l.count.Load() == before; time.Sleep(10 * time.Millisecond) {
			if time.Now().After(deadline) {
				t.Fatalf("no frame from %s", u)
			}
		}
	}
}

func liveSelectIsDrawnByTheGUI(t *testing.T, l *live) {
	ctx := context.Background()
	l.click(100, 35)
	st := l.until("the select", func(st State) bool { return st.Select != nil })
	if len(st.Select.Options) != 4 || st.Select.Options[1].Label != "two" || !st.Select.Options[2].Disabled || st.Select.Selected != 0 {
		t.Fatalf("select: %+v", st.Select)
	}
	if err := l.s.PickSelect(ctx, l.key, st.Select.ID, 3); err != nil {
		t.Fatal(err)
	}
	l.evalUntil("s.value", eq("four"))
	l.evalUntil("log.join()", eq("change four"))
	if err := l.s.PickSelect(ctx, l.key, st.Select.ID, 1); err == nil {
		t.Fatal("answered the same select twice")
	}
	// A Mac opens the popup from the keyboard too.
	l.eval("s.focus()", nil)
	l.press("ArrowDown", "ArrowDown", 40, 0)
	st = l.until("the select again", func(st State) bool { return st.Select != nil })
	if st.Select.Selected != 3 {
		t.Fatalf("select: %+v", st.Select)
	}
	if err := l.s.PickSelect(ctx, l.key, st.Select.ID, -1); err != nil {
		t.Fatal(err)
	}
}

func liveDialogsAskTheViewer(t *testing.T, l *live) {
	ctx := context.Background()
	l.eval(`setTimeout(()=>{window.r=prompt("Your name?","Ada")},0);1`, nil)
	st := l.until("the prompt", func(st State) bool { return st.Dialog != nil })
	d := st.Dialog
	if d.Kind != "prompt" || d.Message != "Your name?" || d.DefaultPrompt != "Ada" || d.Origin != l.srv.URL {
		t.Fatalf("dialog: %+v", d)
	}
	if err := l.s.Input(ctx, l.key, []InputEvent{{Mouse: &MouseEvent{Type: "mouseMoved", Button: "none", X: 1, Y: 1}}}); err != nil {
		t.Fatalf("input during a dialog must not wait on it: %v", err)
	}
	if err := l.s.AnswerDialog(ctx, l.key, d.ID, true, "Grace"); err != nil {
		t.Fatal(err)
	}
	l.evalUntil("String(window.r)", eq("Grace"))

	// A page that will not stop asking can still be left.
	l.eval(`setTimeout(()=>{alert("stuck")},0);1`, nil)
	l.until("the alert", func(st State) bool { return st.Dialog != nil })
	if _, err := l.s.Navigate(ctx, l.key, l.srv.URL+"/two"); err != nil {
		t.Fatal(err)
	}
	l.until("the next page", func(st State) bool { return st.Title == "Two" && st.Dialog == nil })
}

func liveNewWindowsLandInTheSurfaceAndCloseBack(t *testing.T, l *live) {
	ctx := context.Background()
	for _, tt := range []struct {
		name string
		x, y float64
	}{{"target=_blank", 30, 208}, {"window.open", 135, 212}} {
		t.Run(tt.name, func(t *testing.T) {
			l.click(tt.x, tt.y)
			st := l.until("the popup", func(st State) bool { return st.Popup && st.Title == "Two" })
			if !st.CanGoBack {
				t.Fatal("no way back from a popup")
			}
			l.evalUntil("innerWidth+''", eq("640"))
			if err := l.s.Go(ctx, l.key, -1); err != nil {
				t.Fatal(err)
			}
			l.until("the opener", func(st State) bool { return !st.Popup && st.Title == "Live page" })
		})
	}
}

func liveWindowCloseComesBackToTheOpener(t *testing.T, l *live) {
	l.click(135, 212)
	l.until("the popup", func(st State) bool { return st.Popup && st.Title == "Two" })
	// The page shown is the popup; its opener still holds it, as a sign-in would.
	in, sf, _, err := l.s.shown(l.key)
	if err != nil {
		t.Fatal(err)
	}
	opener := sf.stack[0]
	if err := evaluate(context.Background(), in, opener.session, "w.close(); 1", nil); err != nil {
		t.Fatal(err)
	}
	l.until("the opener", func(st State) bool { return !st.Popup && st.Title == "Live page" })
}

func liveAddressRuleHolds(t *testing.T, l *live) {
	ctx := context.Background()
	for _, bad := range []string{"file:///etc/hosts", "chrome://settings", "devtools://devtools/bundled/inspector.html", "javascript:document.title='pwned'", "data:text/html,x"} {
		if _, err := l.s.Navigate(ctx, l.key, bad); err == nil {
			t.Fatalf("%s reached Chrome", bad)
		}
	}
	if st := l.now(); st.Title != "Live page" {
		t.Fatalf("title %q", st.Title)
	}
	// A page cannot walk there either: Chrome stops it, and the surface stays on an allowed page.
	l.eval(`location.href="file:///etc/hosts";1`, nil)
	l.eval(`window.open("chrome://settings");1`, nil)
	time.Sleep(300 * time.Millisecond)
	if st := l.now(); !allowedPage(st.URL) {
		t.Fatalf("on %q", st.URL)
	}
}

func liveFileChooserAndDownload(t *testing.T, l *live) {
	ctx := context.Background()
	l.click(60, 250)
	st := l.until("the chooser", func(st State) bool { return st.FileChooser != nil })
	if st.FileChooser.Multiple || st.FileChooser.Origin != l.srv.URL {
		t.Fatalf("chooser: %+v", st.FileChooser)
	}
	path := filepath.Join(t.TempDir(), "pick.txt")
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := l.s.AnswerFile(ctx, l.key, st.FileChooser.ID, []string{path}); err != nil {
		t.Fatal(err)
	}
	l.evalUntil("f.files.length+f.files[0]?.name", eq("1pick.txt"))

	l.click(25, 288)
	st = l.until("the download", func(st State) bool { return len(st.Downloads) == 1 && st.Downloads[0].State == "completed" })
	d := st.Downloads[0]
	if d.Name != "report.txt" || filepath.Dir(d.Path) != l.s.Downloads() {
		t.Fatalf("download: %+v", d)
	}
	if err := l.s.RevealDownload(l.key, d.ID); err != nil {
		t.Fatal(err)
	}
	if err := l.s.RevealDownload(l.key, "other"); err == nil {
		t.Fatal("revealed an unknown download")
	}
}

func liveClipboardStaysInChromeUntilTheUserMovesIt(t *testing.T, l *live) {
	ctx := context.Background()

	// cmd+c, then the bridge reads it back.
	l.eval(`t.value="copy me";t.focus();t.select();1`, nil)
	l.press("c", "KeyC", 67, modMeta)
	copied := func() string {
		t.Helper()
		if _, err := l.s.Copy(ctx, l.key); err != nil {
			t.Fatal(err)
		}
		return l.copied.Load().(string)
	}
	var got string
	for deadline := time.Now().Add(5 * time.Second); got != "copy me" && time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		got = copied()
	}
	if got != "copy me" {
		t.Fatalf("copied %q", got)
	}
	// Reading happens in a page of our own, and leaves the user's page and focus alone.
	l.copied.Store("what the Mac holds")
	if n, err := l.s.Copy(ctx, l.key); err != nil || n != 0 {
		t.Fatalf("a second cmd+c with nothing new moved %d characters: %v", n, err)
	}
	if got := l.copied.Load(); got != "what the Mac holds" {
		t.Fatalf("the Mac's clipboard became %q", got)
	}
	l.evalUntil("document.activeElement.id", eq("t"))
	l.evalUntil("String(document.hasFocus())", eq("true"))

	// A page's own Copy button goes to Chrome's clipboard, and the surface says so.
	before := l.now().Copied
	l.click(135, 288)
	l.until("the notice", func(st State) bool { return st.Copied > before })
	if got := copied(); got != "from a button" {
		t.Fatalf("copied %q", got)
	}

	// Paste is a real paste, so the page's handlers run.
	l.eval(`t.value="";t.focus();log.length=0;1`, nil)
	if err := l.s.Paste(ctx, l.key, "pasted text"); err != nil {
		t.Fatal(err)
	}
	l.evalUntil("t.value", eq("pasted text"))
	l.evalUntil("log.join()", eq("paste pasted text"))
}

func TestLiveChromeDiesThenRelaunchReturnsToThePage(t *testing.T) {
	l := startLive(t)
	ctx := context.Background()
	l.s.mu.Lock()
	in := l.s.chrome
	l.s.mu.Unlock()
	p := in.proc.(*process)
	p.signal(9) // this test's own Chrome's group
	st := l.until("the crash", func(st State) bool { return st.Phase == PhaseCrashed })
	if !strings.Contains(st.Message, "unexpectedly") {
		t.Fatalf("message %q", st.Message)
	}
	if l.s.Running() {
		t.Fatal("still running")
	}
	<-p.done
	if err := l.s.Relaunch(ctx); err != nil {
		t.Fatal(err)
	}
	l.until("the same page", func(st State) bool { return st.Phase == PhaseReady && st.Title == "Live page" })
	if err := l.s.Input(ctx, l.key, []InputEvent{{Mouse: &MouseEvent{Type: "mouseMoved", Button: "none", X: 5, Y: 5}}}); err != nil {
		t.Fatal(err)
	}
}

func TestLiveNothingOutlivesTheStore(t *testing.T) {
	l := startLive(t)
	l.s.mu.Lock()
	p := l.s.chrome.proc.(*process)
	l.s.mu.Unlock()
	group := p.cmd.Process.Pid
	l.s.Close()
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		// Signal 0 to the group: ESRCH once no member is left.
		if err := syscall.Kill(-group, 0); errors.Is(err, syscall.ESRCH) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("group %d still has members", group)
		}
	}
}

func TestLiveProfileKeepsCookiesAcrossARestart(t *testing.T) {
	l := startLive(t)
	l.eval(`document.cookie="cf=kept; max-age=86400";1`, nil)
	l.v.Close()
	l.s.mu.Lock()
	in := l.s.chrome
	l.s.mu.Unlock()
	l.s.stop(in)
	l.mu.Lock()
	l.state = State{}
	l.mu.Unlock()
	l.watch("")
	l.until("the page again", func(st State) bool { return st.Phase == PhaseReady && st.Title == "Live page" })
	l.evalUntil("document.cookie", eq("cf=kept"))
}
