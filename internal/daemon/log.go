package daemon

import (
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"time"
)

// newLogger returns a logger that writes JSON to logPath and, in dev mode, text to
// stderr. The returned closer closes the log file. The file handler's level is the
// returned LevelVar (settings: advanced.log_level); dev mode logs at debug.
func newLogger(logPath string, dev bool, stderr io.Writer) (*slog.Logger, *slog.LevelVar, io.Closer, error) {
	f, err := os.OpenFile(logPath, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("open log %s: %w", logPath, err)
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
