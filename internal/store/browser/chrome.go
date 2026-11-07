package browser

import (
	"bytes"
	"context"
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
	"syscall"
	"time"
)

// EnvChromeBin overrides where Chrome is found (development: a Beta or a stand-in).
const EnvChromeBin = "CODE_FOUNDRY_CHROME_BIN"

// ErrNoChrome is what a surface says when this Mac has no Google Chrome.
var ErrNoChrome = errors.New("Google Chrome is not installed: this surface drives the Chrome in /Applications")

// chromeApp is the executable inside the app bundle.
const chromeApp = "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

// FindChrome is the system Chrome: $CODE_FOUNDRY_CHROME_BIN, else /Applications, else
// ~/Applications. Never the PATH: this is the program that gets the user's logins.
func FindChrome(home string) (string, error) {
	if p := os.Getenv(EnvChromeBin); p != "" {
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
		"about:blank",
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
}

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

// Stop closes the pipe, which Chrome takes as the order to exit, then signals its process
// group: that group is Chrome and its helpers and nothing else (Setpgid above). It stops only
// the process it started, never one found by name.
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
// exits by itself within a second of the pipe closing; a new one started before that would
// hand over to it and exit. So this waits, and only a Chrome that does not go is signalled,
// and only after its own command line has been read back and names this profile.
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
