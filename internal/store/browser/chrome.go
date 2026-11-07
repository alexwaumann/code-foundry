package browser

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/alexwaumann/code-foundry/internal/version"
)

// EnvChromeBin overrides where Chrome is found, in a dev build only (a Beta or a stand-in). It
// decides which program gets the pipe and the profile with the user's sign-ins, so a build the
// user installed never reads it.
const EnvChromeBin = "CODE_FOUNDRY_CHROME_BIN"

// ErrNoChrome is what a surface says when this Mac has no Google Chrome.
var ErrNoChrome = errors.New("no Google Chrome on this Mac: this surface drives the one in /Applications")

// chromeApp is the executable inside the app bundle.
const chromeApp = "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

// FindChrome is the system Chrome: /Applications, else ~/Applications, and in a dev build
// $CODE_FOUNDRY_CHROME_BIN first. Never the PATH: this is the program that gets the user's logins.
func FindChrome(home string) (string, error) {
	if p := os.Getenv(EnvChromeBin); p != "" && version.Version == "dev" {
		return p, nil
	}
	for _, p := range []string{"/" + chromeApp, filepath.Join(home, chromeApp)} {
		if st, err := os.Stat(p); err == nil && !st.IsDir() && st.Mode()&0o111 != 0 {
			return p, nil
		}
	}
	return "", ErrNoChrome
}

// chromeArgs are the flags of the one Chrome. No flag changes what Chrome says it is: a site
// that refuses a headless browser is refused, as docs/notes/chrome-surface.md records.
func chromeArgs(profile string) []string {
	return []string{
		"--headless=new",
		// Never --remote-debugging-port: a port would hand a logged-in browser to any local program.
		"--remote-debugging-pipe",
		"--force-device-scale-factor=2",
		"--user-data-dir=" + profile,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-blink-features=" + strings.Join(systemUIFeatures, ","),
		// Headless Chrome writes every console line of every page to stderr, on its main thread,
		// and a page can log faster than any pipe takes it: every surface then waits on that write.
		// A console line is logged at INFO; a launch that fails says why at ERROR.
		"--log-level=2",
		// A video in a window of its own, floating over the real desktop.
		"--blink-settings=pictureInPictureEnabled=false",
		// A page past this ends its own process and nothing else. Memory outside the heap is
		// watchMemory's.
		"--js-flags=--max-old-space-size=" + strconv.Itoa(maxHeapMB),
		"about:blank",
	}
}

// maxHeapMB bounds one renderer's JavaScript heap. Chrome's default is about twice this.
const maxHeapMB = 2048

// systemUIFeatures are the web APIs that would reach past the surface to the Mac's own panels or
// sheets, which nobody can answer through a frame and which the file chooser's interception does
// not cover. Off, a page sees them undefined and takes whatever path it has without them.
var systemUIFeatures = []string{
	"FileSystemAccess", "FileSystemAccessLocal", // showOpenFilePicker and friends: a real open panel
	"WebAuth",                     // only hides PublicKeyCredential; WebAuthn.enable is the block (surface.go)
	"WebShare",                    // the share sheet
	"EyeDropperAPI",               // a colour picker over the real screen
	"DocumentPictureInPictureAPI", // a window of the page's own on the real desktop
	"FedCm",                       // sign-in prompts in a window nobody sees
	"Serial", "WebUSB", "WebHID", "WebBluetooth",
	"Presentation",
}

// profilePrefs are what no flag sets, written into the profile before each launch. No print dialog:
// it would wait in Chrome's hidden window. A page reaches only the web: without the allow list,
// a mailto: or a custom scheme opens the app that handles it, which Chrome does for mailto: without
// asking. Chrome's error for what is refused is ERR_BLOCKED_BY_ADMINISTRATOR. And a PDF downloads,
// under the same rule as any download, instead of opening Chrome's viewer: that is an extension
// page with Download and Print buttons of its own, which none of this was built around. Nothing
// downloaded is opened by Chrome, a PDF in the Mac's own reader least of all.
var profilePrefs = map[string]any{
	"printing": map[string]any{"enabled": false},
	"plugins":  map[string]any{"always_open_pdf_externally": true},
	"download": map[string]any{"open_pdf_in_system_reader": false, "extensions_to_open": ""},
	"policy": map[string]any{
		"url_blocklist": []string{"*"},
		"url_allowlist": []string{"http://*", "https://*", "about:*", "blob:*", "data:*"},
	},
}

// hardenProfile puts profilePrefs over the profile's Preferences, whatever else they hold. A file
// that does not parse is left for Chrome to reset, and is replaced by the prefs alone.
func hardenProfile(profile string) error {
	path := filepath.Join(profile, "Default", "Preferences")
	prefs := map[string]any{}
	if b, err := os.ReadFile(path); err == nil && json.Unmarshal(b, &prefs) != nil {
		prefs = map[string]any{}
	}
	merge(prefs, profilePrefs)
	b, err := json.Marshal(prefs)
	if err != nil {
		return fmt.Errorf("browser profile: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("browser profile: %w", err)
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		return fmt.Errorf("browser profile: %w", err)
	}
	return nil
}

// merge sets over's keys in into, table by table.
func merge(into, over map[string]any) {
	for k, v := range over {
		sub, ok := v.(map[string]any)
		if !ok {
			into[k] = v
			continue
		}
		have, ok := into[k].(map[string]any)
		if !ok {
			have = map[string]any{}
			into[k] = have
		}
		merge(have, sub)
	}
}

// chromeEnv is the little Chrome inherits. The daemon's own environment may hold what a
// browser has no business seeing, and every page's renderer descends from this process.
func chromeEnv() []string {
	var env []string
	for _, k := range []string{"HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "LANG", "LC_ALL", "__CF_USER_TEXT_ENCODING"} {
		if v, ok := os.LookupEnv(k); ok {
			env = append(env, k+"="+v)
		}
	}
	return env
}

// Process is a running Chrome.
type Process interface {
	// Pipes are what the protocol runs over: Chrome's fd 3 and fd 4.
	Pipes() (toChrome io.WriteCloser, fromChrome io.Reader)
	// Done is closed once the process has exited.
	Done() <-chan struct{}
	// Stop ends the process and all its helpers, gently first, and returns once they are gone.
	Stop()
	// Tail is the end of Chrome's stderr, for a launch that failed. It can quote URLs, so
	// it goes to the viewer and the debug log.
	Tail() string
}

// Launcher starts Chrome on a profile. Tests give a fake (browsertest).
type Launcher func(ctx context.Context, profile string) (Process, error)

// stopGrace is how long Chrome gets after each step of Stop.
const stopGrace = 3 * time.Second

// tailBytes is how much of Chrome's stderr is kept.
const tailBytes = 4 << 10

// ExecLauncher starts the Chrome at bin. Chrome exits by itself when the pipe closes, so the
// daemon dying in any way, SIGKILL included, takes it along: the write end is close-on-exec and
// only the daemon holds it.
func ExecLauncher(find func() (string, error), log *slog.Logger) Launcher {
	return func(_ context.Context, profile string) (Process, error) {
		bin, err := find()
		if err != nil {
			return nil, err
		}
		if err := os.MkdirAll(profile, 0o700); err != nil {
			return nil, fmt.Errorf("browser profile: %w", err)
		}
		reapStale(profile, log)
		if err := hardenProfile(profile); err != nil {
			return nil, err
		}
		inR, inW, err := os.Pipe()
		if err != nil {
			return nil, fmt.Errorf("chrome pipe: %w", err)
		}
		outR, outW, err := os.Pipe()
		if err != nil {
			_ = inR.Close()
			_ = inW.Close()
			return nil, fmt.Errorf("chrome pipe: %w", err)
		}
		errR, errW, err := os.Pipe()
		if err != nil {
			for _, f := range []*os.File{inR, inW, outR, outW} {
				_ = f.Close()
			}
			return nil, fmt.Errorf("chrome pipe: %w", err)
		}
		cmd := exec.Command(bin, chromeArgs(profile)...)
		cmd.Env = chromeEnv()
		cmd.Dir = filepath.Dir(profile)
		cmd.Stderr = errW
		cmd.ExtraFiles = []*os.File{inR, outW} // fd 3 and fd 4
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		err = cmd.Start()
		for _, f := range []*os.File{inR, outW, errW} {
			_ = f.Close()
		}
		if err != nil {
			for _, f := range []*os.File{inW, outR, errR} {
				_ = f.Close()
			}
			return nil, fmt.Errorf("start chrome: %w", err)
		}
		p := &process{cmd: cmd, toChrome: inW, fromChrome: outR, done: make(chan struct{}), log: log}
		go p.drain(errR)
		go p.watchMemory()
		go func() {
			_ = cmd.Wait()
			close(p.done)
			// A helper may still hold the write end, so the read would not end by itself.
			_ = outR.Close()
		}()
		log.Debug("chrome started", "pid", cmd.Process.Pid)
		return p, nil
	}
}

type process struct {
	cmd        *exec.Cmd
	toChrome   *os.File
	fromChrome *os.File
	done       chan struct{}
	log        *slog.Logger

	mu   sync.Mutex
	tail []byte
	// blame is the store's word on a swell of Chrome's own process (memoryWatch.blame).
	blame atomic.Pointer[func() bool]
}

// blameWith sets who is asked when Chrome's own process swells: the store, which knows which page
// was pushing history. It reports whether it closed one.
func (p *process) blameWith(f func() bool) { p.blame.Store(&f) }

func (p *process) Pipes() (io.WriteCloser, io.Reader) { return p.toChrome, p.fromChrome }
func (p *process) Done() <-chan struct{}              { return p.done }

func (p *process) Tail() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return string(bytes.TrimSpace(p.tail))
}

// drain keeps the end of stderr: Chrome would block on a full pipe otherwise.
func (p *process) drain(r *os.File) {
	defer func() { _ = r.Close() }()
	buf := make([]byte, 4096)
	for {
		n, err := r.Read(buf)
		p.mu.Lock()
		p.tail = append(p.tail, buf[:n]...)
		if len(p.tail) > tailBytes {
			p.tail = p.tail[len(p.tail)-tailBytes:]
		}
		p.mu.Unlock()
		if err != nil {
			return
		}
	}
}

// Stop closes the pipe, which Chrome takes as the order to exit, then signals its process group
// if it has to, and in any case sweeps it: that group is Chrome and its helpers and nothing else
// (Setpgid above). It stops only the process it started, never one found by name.
func (p *process) Stop() {
	_ = p.toChrome.Close()
	if p.wait(stopGrace) {
		p.killGroup()
		return
	}
	p.signal(syscall.SIGTERM)
	if p.wait(stopGrace) {
		p.killGroup()
		return
	}
	p.killGroup()
	p.wait(stopGrace)
}

func (p *process) wait(d time.Duration) bool {
	select {
	case <-p.done:
		return true
	case <-time.After(d):
		return false
	}
}

// Memory no flag bounds. A page can fill a few GB of typed arrays in a second, and a page logging
// in a loop queues its console faster than Chrome's main thread takes it, which every surface then
// waits behind, and no event says so. So the only sign is size, read from outside. A helper past
// maxHelperRSS, or past minGrowthRSS and up by maxGrowth in growthPolls seconds, is killed, which to
// Chrome is a page or a GPU process that crashed.
//
// Chrome's own process can swell too, where nothing names a page, and its main thread can have no
// time left for anyone. Two things do that. history.pushState keeps each entry's state in Chrome's
// process, up to 50 entries a page: eleven of 64 MB took it from 250 MB to 1.3 GB, and killing the
// page's renderer gave none of it back, while closing the page did. So a swell is first the store's
// to blame, on a page that pushed history in the window, which it closes. Past heavyBrowserRSS a
// smaller growth counts, so a page pushing slowly is caught too. Otherwise, as for a console flood,
// it is a helper that is itself hot or growing: about 200% each in a console flood. A helper that is
// merely busy is not blamed: an animated page with a worker takes 80% or more and grows nothing,
// and an earlier rule that took the busiest helper killed such a neighbour of a pushState flood.
//
// Chrome past maxBrowserRSS, or the whole group past maxGroupRSS, goes, and every surface says so,
// which is better than taking the Mac along.
const (
	memoryPoll      = time.Second
	growthPolls     = 5
	maxHelperRSS    = 4 << 20 // KiB, as ps says
	minGrowthRSS    = 1 << 20
	maxGrowth       = 512 << 10
	heavyBrowserRSS = 2 << 20
	heavyGrowth     = 64 << 10
	helperGrowth    = 256 << 10
	maxBrowserRSS   = 6 << 20
	maxGroupRSS     = 12 << 20
	hotCPU          = 150.0
	hotPolls        = 3
)

// watchMemory polls Chrome's process group until it exits.
func (p *process) watchMemory() {
	tick := time.NewTicker(memoryPoll)
	defer tick.Stop()
	w := memoryWatch{pid: p.cmd.Process.Pid, blame: func() bool {
		if f := p.blame.Load(); f != nil {
			return (*f)()
		}
		return false
	}}
	for {
		select {
		case <-p.done:
			return
		case <-tick.C:
		}
		out, err := exec.Command("/bin/ps", "-A", "-o", "pid=,pgid=,rss=,pcpu=").Output()
		if err != nil {
			continue
		}
		helpers, browser := w.read(string(out))
		for _, h := range helpers {
			p.log.Warn("killed a Chrome process past its memory limit", "pid", h)
			_ = syscall.Kill(h, syscall.SIGKILL)
		}
		if browser {
			p.log.Warn("killed Chrome: past its memory limit")
			p.killGroup()
		}
	}
}

// memoryWatch reads ps a poll at a time.
type memoryWatch struct {
	pid  int
	past map[int][]int // each process's last sizes, oldest first
	hot  int           // polls in a row Chrome's own process has been past hotCPU
	// blame asks the store about a swell of Chrome's own process, and reports whether it closed
	// the page doing it. Nil asks nobody.
	blame func() bool
}

// read says which helpers of the group led by pid are to go, and whether pid itself is.
func (w *memoryWatch) read(ps string) (helpers []int, browser bool) {
	past := map[int][]int{}
	grew := func(who, rss int) int {
		sizes := append(w.past[who], rss)
		if len(sizes) > growthPolls {
			sizes = sizes[1:]
		}
		past[who] = sizes
		return rss - sizes[0]
	}
	// culprit is the busiest helper that is itself hot or growing, the only kind a strain of
	// Chrome's own process is blamed on.
	culprit, busy, swelling, heavy, total := 0, 0.0, false, false, 0
	for line := range strings.Lines(ps) {
		f := strings.Fields(line)
		if len(f) != 4 {
			continue
		}
		who, err1 := strconv.Atoi(f[0])
		group, err2 := strconv.Atoi(f[1])
		rss, err3 := strconv.Atoi(f[2])
		cpu, err4 := strconv.ParseFloat(f[3], 64)
		switch {
		case err1 != nil || err2 != nil || err3 != nil || err4 != nil || group != w.pid:
		case who == w.pid:
			total += rss
			browser = browser || rss > maxBrowserRSS
			grown := grew(who, rss)
			swelling = grown > maxGrowth
			heavy = rss > heavyBrowserRSS && grown > heavyGrowth
			if w.hot++; cpu < hotCPU {
				w.hot = 0
			}
		default:
			total += rss
			grown := grew(who, rss)
			if rss > maxHelperRSS || (rss > minGrowthRSS && grown > maxGrowth) {
				helpers = append(helpers, who)
			}
			if (cpu >= hotCPU || grown > helperGrowth) && cpu >= busy {
				culprit, busy = who, cpu
			}
		}
	}
	w.past = past
	hot := w.hot >= hotPolls
	if len(helpers) > 0 || !(swelling || heavy || hot) {
		return helpers, browser || total > maxGroupRSS
	}
	switch {
	case (swelling || heavy) && w.blame != nil && w.blame():
	case (swelling || hot) && culprit != 0:
		helpers = append(helpers, culprit)
	default:
		// Nobody to blame: the limits on Chrome and the group stay the last line.
		return helpers, browser || total > maxGroupRSS
	}
	delete(w.past, w.pid) // it will not shrink: the next blame needs new growth
	w.hot = 0
	return helpers, browser || total > maxGroupRSS
}

// killGroup takes any helper that outlived the browser process. The group id stays reserved
// while a member lives, and ESRCH is the usual answer.
func (p *process) killGroup() { p.signal(syscall.SIGKILL) }

func (p *process) signal(sig syscall.Signal) {
	if pid := p.cmd.Process.Pid; pid > 1 {
		_ = syscall.Kill(-pid, sig)
	}
}

// staleWait is how long a Chrome left by a daemon that died gets to finish exiting.
const staleWait = 3 * time.Second

// reapStale deals with the Chrome of a daemon that just died, still holding the profile. It
// exits by itself within a second of the pipe closing; a new one started before that finds the
// profile in use and exits with status 21, with nothing handed to anyone. So this waits, and only
// a Chrome that does not go is signalled, and only after its own command line has been read back
// and names this profile.
func reapStale(profile string, log *slog.Logger) {
	pid := lockHolder(profile)
	if pid == 0 {
		return
	}
	for deadline := time.Now().Add(staleWait); time.Now().Before(deadline); time.Sleep(100 * time.Millisecond) {
		if !holdsProfile(pid, profile) {
			return
		}
	}
	if holdsProfile(pid, profile) {
		log.Warn("stopping a Chrome left on the surface's profile", "pid", pid)
		_ = syscall.Kill(pid, syscall.SIGKILL)
		time.Sleep(200 * time.Millisecond)
	}
}

// lockHolder is the pid in Chrome's SingletonLock, a symlink to "<host>-<pid>"; 0 for none.
func lockHolder(profile string) int {
	target, err := os.Readlink(filepath.Join(profile, "SingletonLock"))
	if err != nil {
		return 0
	}
	i := strings.LastIndexByte(target, '-')
	if i < 0 {
		return 0
	}
	pid, err := strconv.Atoi(target[i+1:])
	if err != nil || pid <= 1 {
		return 0
	}
	return pid
}

// holdsProfile reports whether pid is a process started on exactly this profile.
func holdsProfile(pid int, profile string) bool {
	out, err := exec.Command("/bin/ps", "-ww", "-o", "command=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return false
	}
	return strings.Contains(string(out), "--user-data-dir="+profile+" ")
}
