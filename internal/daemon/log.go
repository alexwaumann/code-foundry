package daemon

import (
	"io"
	"log/slog"
	"net/http"
	"os"
	"syscall"
	"time"

	"github.com/alexwaumann/code-foundry/internal/logfile"
)

// logMaxBytes caps daemon.log; past it the file rotates to daemon.log.1 (one rotation,
// like the plugins' logs).
const logMaxBytes = 10 << 20

// newLogger returns a logger that writes JSON to logPath and, in dev mode, text to
// stderr. The returned closer closes the log file. The file handler's level is the
// returned LevelVar (settings: advanced.log_level); dev mode logs at debug.
func newLogger(logPath string, dev bool, stderr io.Writer) (*slog.Logger, *slog.LevelVar, io.Closer, error) {
	var opts []logfile.Option
	if stdioIsLog(logPath) {
		// An auto-started daemon's stdout and stderr are this file (client.spawnDaemon).
		// Keep them on the live file across rotations, so a panic lands with the rest.
		opts = append(opts, logfile.OnRotate(func(f *os.File) {
			fd := int(f.Fd())
			_ = syscall.Dup2(fd, 1)
			_ = syscall.Dup2(fd, 2)
		}))
	}
	f, err := logfile.Open(logPath, logMaxBytes, opts...)
	if err != nil {
		return nil, nil, nil, err
	}
	level := new(slog.LevelVar)
	if dev {
		level.Set(slog.LevelDebug)
	}
	var h slog.Handler = slog.NewJSONHandler(f, &slog.HandlerOptions{Level: level})
	if dev {
		h = slog.NewMultiHandler(h, slog.NewTextHandler(stderr, &slog.HandlerOptions{Level: level}))
	}
	return slog.New(h), level, f, nil
}

// stdioIsLog reports whether this process's stderr is the file at logPath.
func stdioIsLog(logPath string) bool {
	a, err := os.Stderr.Stat()
	if err != nil {
		return false
	}
	b, err := os.Stat(logPath)
	if err != nil {
		return false
	}
	return os.SameFile(a, b)
}

// logRequests logs each request at debug level. The wrapper keeps http.Flusher and
// Unwrap so Connect streaming and http.ResponseController keep working.
func logRequests(log *slog.Logger, listener string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !log.Enabled(r.Context(), slog.LevelDebug) {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		log.LogAttrs(r.Context(), slog.LevelDebug, "request",
			slog.String("listener", listener),
			slog.String("method", r.Method),
			slog.String("path", r.URL.Path),
			slog.Int("status", rec.status),
			slog.String("proto", r.Proto),
			slog.String("origin", r.Header.Get("Origin")),
			slog.Duration("dur", time.Since(start)),
		)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (s *statusRecorder) WriteHeader(code int) {
	if !s.wroteHeader {
		s.status, s.wroteHeader = code, true
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	s.wroteHeader = true
	return s.ResponseWriter.Write(b)
}

func (s *statusRecorder) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }
