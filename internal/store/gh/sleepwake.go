package gh

import (
	"context"
	"errors"
	"io"
	"net"
	"strings"
	"sync"
	"syscall"
	"time"
)

// ConnectionDropper is an optional interface implemented by runners that pool persistent
// connections (HTTPRunner). The store calls CloseIdleConnections on system wake so
// half-open keep-alive sockets left behind by sleep are discarded before the next request.
type ConnectionDropper interface {
	CloseIdleConnections()
}

var _ ConnectionDropper = (*HTTPRunner)(nil)

// Sleep/wake detection and recovery parameters.
const (
	// wakeCheckInterval is how often Store.Run checks the wall clock against monotonic
	// time to detect system sleep/wake.
	wakeCheckInterval = 5 * time.Second
	// sleepSkewThreshold is the minimum wall-clock jump ahead of monotonic time
	// (wallDelta - monoDelta) treated as a sleep/wake transition. Go's monotonic clock
	// pauses during system sleep on both macOS and Linux while wall time advances; using
	// skew alone guarantees a busy worker executing a slow 30s request never reads as a
	// wake and never resets network backoff.
	sleepSkewThreshold = 10 * time.Second
	// wakeGraceWindow is how long after a detected wake a read-only request on even a
	// newly dialed connection gets one retry on a pre-response connection reset/EOF.
	wakeGraceWindow = 15 * time.Second
)

// wakeSample captures wall and monotonic readings at the same instant. wall has its
// monotonic reading stripped via Round(0); mono retains it when available.
type wakeSample struct {
	wall time.Time
	mono time.Time
}

func systemWakeSample() wakeSample {
	t := time.Now()
	return wakeSample{wall: t.Round(0), mono: t}
}

// wakeConfig injects deterministic sleep/wake triggers in tests. Nil in production.
type wakeConfig struct {
	tickInterval time.Duration
	ticks        <-chan time.Time
	sample       func() wakeSample
}

// sleepJump reports whether the transition (wallDelta, monoDelta) indicates a sleep/wake
// jump, returning the estimated sleep duration. Backward wall-clock jumps (NTP step-back)
// and normal awake elapsed time (wallDelta == monoDelta, e.g. a busy worker executing a
// slow HTTP call) never trigger.
func sleepJump(wallDelta, monoDelta time.Duration) (time.Duration, bool) {
	if skew := wallDelta - monoDelta; skew >= sleepSkewThreshold {
		return skew, true
	}
	return 0, false
}

// sleepDetector tracks clock samples to detect macOS/Linux sleep/wake transitions. Safe
// for concurrent use from the worker loop and interactive callers.
type sleepDetector struct {
	mu     sync.Mutex
	sample func() wakeSample
	last   wakeSample
}

func newSleepDetector(sample func() wakeSample) *sleepDetector {
	if sample == nil {
		sample = systemWakeSample
	}
	return &sleepDetector{
		sample: sample,
		last:   sample(),
	}
}

// checkTick evaluates monotonic-vs-wall skew and advances the baseline sample.
func (d *sleepDetector) checkTick() (time.Duration, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	cur := d.sample()
	wallDelta := cur.wall.Sub(d.last.wall)
	monoDelta := cur.mono.Sub(d.last.mono)
	d.last = cur
	return sleepJump(wallDelta, monoDelta)
}

// checkSkew opportunistically detects monotonic-vs-wall skew (e.g. a user click arriving
// immediately after lid-open before the heartbeat tick fires). It advances the baseline
// only when a jump is detected so a subsequent tick does not double-fire.
func (d *sleepDetector) checkSkew() (time.Duration, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	cur := d.sample()
	wallDelta := cur.wall.Sub(d.last.wall)
	monoDelta := cur.mono.Sub(d.last.mono)
	jump, ok := sleepJump(wallDelta, monoDelta)
	if ok {
		d.last = cur
	}
	return jump, ok
}

func (s *Store) initWakeDetector() {
	var sample func() wakeSample
	if s.opts.wake != nil {
		sample = s.opts.wake.sample
	}
	s.sleepDet = newSleepDetector(sample)
}

func (s *Store) startWakeMonitor() (<-chan time.Time, func()) {
	if s.opts.wake != nil && s.opts.wake.ticks != nil {
		return s.opts.wake.ticks, func() {}
	}
	interval := wakeCheckInterval
	if s.opts.wake != nil && s.opts.wake.tickInterval > 0 {
		interval = s.opts.wake.tickInterval
	}
	t := time.NewTicker(interval)
	return t.C, t.Stop
}

func (s *Store) checkWakeTick() {
	if s.sleepDet == nil {
		return
	}
	if jump, ok := s.sleepDet.checkTick(); ok {
		s.onWake(jump)
	}
}

func (s *Store) checkWakeSkew() {
	if s.sleepDet == nil {
		return
	}
	if jump, ok := s.sleepDet.checkSkew(); ok {
		s.onWake(jump)
	}
}

// onWake recovers from a detected system sleep/wake transition:
//  1. Drops stale idle HTTP connections (and arms HTTPRunner's brief post-wake retry grace).
//  2. Clears any stale transient ErrNetwork pause (never rate-limit or auth pauses).
//  3. Schedules an immediate poll when foreground and not auth/rate-limit paused.
func (s *Store) onWake(jump time.Duration) {
	if cd, ok := s.opts.Runner.(ConnectionDropper); ok {
		cd.CloseIdleConnections()
	}
	now := s.opts.Now()
	pres := s.presence()
	s.mu.Lock()
	clearedNetPause := false
	if !s.pauseUntil.IsZero() {
		if s.pauseErr != nil && errors.Is(s.pauseErr, ErrNetwork) && !errors.Is(s.pauseErr, ErrRateLimited) {
			s.pauseUntil = time.Time{}
			s.pauseErr = nil
			s.globalFailures = 0
			clearedNetPause = true
		} else {
			// Strip monotonic reading on any remaining pause (rate limit) so a pause
			// whose wall-clock deadline elapsed during sleep is not held by a frozen
			// monotonic clock, while any still-active rate-limit pause stays intact.
			s.pauseUntil = s.pauseUntil.Round(0)
		}
	}
	pollNow := false
	if !s.authBad && s.pausedLocked() == nil && pres == PresenceForeground {
		s.pollAgain = true
		if s.pollNext.After(now) {
			s.pollNext = now
		}
		pollNow = true
	}
	s.mu.Unlock()
	s.log.Info("gh wake detected", "jump", jump.Round(time.Second).String(),
		"cleared_net_pause", clearedNetPause, "poll_now", pollNow, "tier", pres.String())
	if pollNow || clearedNetPause {
		s.nudge()
	}
}

// CloseIdleConnections implements ConnectionDropper: discards idle keep-alive sockets and
// records the wake timestamp for a brief post-wake retry grace window on read-only calls.
func (r *HTTPRunner) CloseIdleConnections() {
	r.opts.Client.CloseIdleConnections()
	r.mu.Lock()
	r.lastWake = r.opts.Now()
	r.mu.Unlock()
}

func (r *HTTPRunner) inWakeGrace(now time.Time) bool {
	r.mu.Lock()
	w := r.lastWake
	r.mu.Unlock()
	if w.IsZero() {
		return false
	}
	d := now.Sub(w)
	return d >= 0 && d <= wakeGraceWindow
}

// shouldRetryConnReset reports whether a failed HTTP attempt may be retried once on a
// fresh connection: only for read-only (idempotent) requests that failed before any
// response bytes arrived with a connection-reset / EOF / broken-pipe error, on either a
// reused pooled connection or within the brief post-wake grace window.
func (r *HTTPRunner) shouldRetryConnReset(idempotent, reused, gotFirstByte bool, now time.Time, err error) bool {
	if !idempotent || gotFirstByte || err == nil {
		return false
	}
	if !isConnResetErr(err) {
		return false
	}
	return reused || r.inWakeGrace(now)
}

// isConnResetErr reports whether err is a dead-socket / connection-reset transport failure
// (not a timeout, caller cancellation, connection refusal, or DNS/TLS error).
func isConnResetErr(err error) bool {
	if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) ||
		errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.EPIPE) ||
		errors.Is(err, syscall.ECONNABORTED) || errors.Is(err, net.ErrClosed) {
		return true
	}
	// Go's bundled http2 client surfaces unexported connection-closed / GOAWAY errors as
	// strings without wrapping the sentinels above.
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "connection reset by peer") ||
		strings.Contains(msg, "broken pipe") ||
		strings.Contains(msg, "use of closed network connection") ||
		strings.Contains(msg, "http2: client connection lost") ||
		strings.Contains(msg, "http2: server sent goaway")
}

// isMutationDoc reports whether a GraphQL document contains a top-level mutation (or
// subscription) operation, safely skipping leading whitespace, `#` comments, and any
// preceding fragment definitions. Mutations are NEVER retried on connection reset.
func isMutationDoc(doc string) bool {
	depth := 0
	for i := 0; i < len(doc); {
		c := doc[i]
		switch {
		case c == '#':
			for i < len(doc) && doc[i] != '\n' {
				i++
			}
		case c == '"':
			// Skip string literals (including triple-quoted block strings).
			if i+2 < len(doc) && doc[i+1] == '"' && doc[i+2] == '"' {
				i += 3
				for i+2 < len(doc) {
					if doc[i] == '\\' && i+3 < len(doc) {
						i += 2
						continue
					}
					if doc[i] == '"' && doc[i+1] == '"' && doc[i+2] == '"' {
						i += 3
						break
					}
					i++
				}
			} else {
				i++
				for i < len(doc) {
					if doc[i] == '\\' && i+1 < len(doc) {
						i += 2
						continue
					}
					if doc[i] == '"' {
						i++
						break
					}
					i++
				}
			}
		case c == '{':
			depth++
			i++
		case c == '}':
			if depth > 0 {
				depth--
			}
			i++
		case depth == 0 && isIdentStart(c):
			start := i
			for i < len(doc) && isIdentChar(doc[i]) {
				i++
			}
			word := doc[start:i]
			if word == "mutation" || word == "subscription" {
				return true
			}
		default:
			i++
		}
	}
	return false
}

func isIdentStart(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_'
}

func isIdentChar(c byte) bool {
	return isIdentStart(c) || (c >= '0' && c <= '9')
}
