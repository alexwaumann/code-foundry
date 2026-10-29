package whisper

/*
#include <dispatch/dispatch.h>
#include <unistd.h>

// The dispatch source's handler runs on a libdispatch thread and never enters Go: it
// writes one byte ('w' warn, 'c' critical) to a pipe that a Go goroutine reads.
static int cf_mp_fd = -1;
static dispatch_source_t cf_mp_src;
static void cf_mp_handler(void *ctx) {
	(void)ctx;
	unsigned long flags = dispatch_source_get_data(cf_mp_src);
	char b;
	if (flags & DISPATCH_MEMORYPRESSURE_CRITICAL) b = 'c';
	else if (flags & DISPATCH_MEMORYPRESSURE_WARN) b = 'w';
	else return;
	ssize_t n = write(cf_mp_fd, &b, 1);
	(void)n;
}
static int cf_mp_start(int fd) {
	if (cf_mp_src) return 0;
	cf_mp_fd = fd;
	cf_mp_src = dispatch_source_create(DISPATCH_SOURCE_TYPE_MEMORYPRESSURE, 0,
		DISPATCH_MEMORYPRESSURE_WARN | DISPATCH_MEMORYPRESSURE_CRITICAL,
		dispatch_get_global_queue(QOS_CLASS_UTILITY, 0));
	if (!cf_mp_src) return -1;
	dispatch_source_set_event_handler_f(cf_mp_src, cf_mp_handler);
	dispatch_resume(cf_mp_src);
	return 0;
}
*/
import "C"

import (
	"errors"
	"fmt"
	"os"

	"github.com/alexwaumann/code-foundry/internal/dictate"
)

// pressureWriter keeps the pipe's write end referenced: the C handler writes to its fd
// for the life of the process, and a collected *os.File would close it.
var pressureWriter *os.File

// WatchMemoryPressure delivers the system's memory-pressure warnings and critical
// notifications. One watch per process.
func (e *Engine) WatchMemoryPressure() (<-chan dictate.Pressure, error) {
	if pressureWriter != nil {
		return nil, errors.New("memory pressure is watched already")
	}
	r, w, err := os.Pipe()
	if err != nil {
		return nil, fmt.Errorf("memory pressure pipe: %w", err)
	}
	var rc C.int
	e.do(func() { rc = C.cf_mp_start(C.int(w.Fd())) })
	if rc != 0 {
		_ = r.Close()
		_ = w.Close()
		return nil, errors.New("could not create the memory-pressure dispatch source")
	}
	pressureWriter = w
	ch := make(chan dictate.Pressure, 4)
	go func() {
		buf := make([]byte, 16)
		for {
			n, err := r.Read(buf)
			for _, b := range buf[:n] {
				p := dictate.PressureWarn
				if b == 'c' {
					p = dictate.PressureCritical
				}
				select {
				case ch <- p:
				default: // the loop has one queued already; it unloads once
				}
			}
			if err != nil {
				return
			}
		}
	}()
	return ch, nil
}
