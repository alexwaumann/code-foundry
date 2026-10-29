// Package whisper is the dictation engine's model: whisper.cpp for transcription and its
// Silero VAD, over cgo. Every C call runs on one goroutine locked to its OS thread (the
// actor); the exported methods hand it closures and wait. Built against the static
// whisper.cpp that scripts/whisper-cpp.sh puts in the per-user cache (`make whisper-cpp`).
package whisper

/*
#cgo pkg-config: whisper-cpp-static
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <mach/mach.h>
#include <whisper.h>

// whisper.cpp and ggml log to stderr at INFO by default, several lines per VAD call.
// Keep warnings and errors (stderr is the engine's log; stdout is the protocol).
static int cf_log_on = 0;
static void cf_log(enum ggml_log_level level, const char *text, void *ud) {
	(void)ud;
	if (level != GGML_LOG_LEVEL_CONT) cf_log_on = level >= GGML_LOG_LEVEL_WARN;
	if (cf_log_on) fputs(text, stderr);
}
static void cf_log_init(void) { whisper_log_set(cf_log, NULL); }

// The embedded Silero model is read from memory through a whisper_model_loader.
typedef struct { const char *data; size_t size; size_t pos; } cf_buf;
static size_t cf_buf_read(void *ctx, void *out, size_t n) {
	cf_buf *b = (cf_buf *)ctx;
	size_t left = b->size - b->pos;
	if (n > left) n = left;
	memcpy(out, b->data + b->pos, n);
	b->pos += n;
	return n;
}
static bool cf_buf_eof(void *ctx) { cf_buf *b = (cf_buf *)ctx; return b->pos >= b->size; }
static void cf_buf_close(void *ctx) { (void)ctx; }

static struct whisper_vad_context *cf_vad_init(const char *data, size_t size, int threads) {
	cf_buf buf = { data, size, 0 };
	struct whisper_model_loader loader = { &buf, cf_buf_read, cf_buf_eof, cf_buf_close };
	struct whisper_vad_context_params p = whisper_vad_default_context_params();
	p.n_threads = threads;
	p.use_gpu = false; // a small LSTM on 32 ms windows: the CPU is quicker than a dispatch
	return whisper_vad_init_with_params(&loader, p);
}

static struct whisper_context *cf_init(const char *path) {
	struct whisper_context_params p = whisper_context_default_params();
	p.use_gpu = true;
	p.flash_attn = true;
	return whisper_init_from_file_with_params(path, p);
}

// One run over one phrase: greedy, English, a single segment without timestamps,
// non-speech tokens suppressed, no temperature fallback, our own prompt instead of
// whisper's carried context.
static int cf_full(struct whisper_context *ctx, const float *samples, int n, int threads, const char *prompt) {
	struct whisper_full_params p = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
	p.n_threads = threads;
	p.language = "en";
	p.detect_language = false;
	p.translate = false;
	p.no_context = true;
	p.no_timestamps = true;
	p.single_segment = true;
	p.suppress_nst = true;
	p.temperature = 0.0f;
	p.temperature_inc = 0.0f;
	p.greedy.best_of = 1;
	p.print_special = false;
	p.print_progress = false;
	p.print_realtime = false;
	p.print_timestamps = false;
	p.initial_prompt = prompt;
	return whisper_full(ctx, p, samples, n);
}

// The footprint Activity Monitor shows (Metal buffers included), in bytes.
static uint64_t cf_footprint(void) {
	task_vm_info_data_t info;
	mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
	if (task_info(mach_task_self(), TASK_VM_INFO, (task_info_t)&info, &count) != KERN_SUCCESS) return 0;
	return info.phys_footprint;
}
*/
import "C"

import (
	_ "embed"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"runtime"
	"strings"
	"syscall"
	"unsafe"
)

// sileroModel is Silero VAD v5.1.2 in ggml format, from
// https://huggingface.co/ggml-org/whisper-vad (MIT; sha256 in
// docs/notes/dictation-1-engine.md).
//
//go:embed ggml-silero-v5.1.2.bin
var sileroModel []byte

// Engine is the model actor. Its zero value is not usable; call Start.
type Engine struct {
	log  *slog.Logger
	reqs chan func()
	done chan struct{}

	// ---- actor goroutine only ----
	ctx     *C.struct_whisper_context
	vad     *C.struct_whisper_vad_context
	threads int
}

// Start starts the actor.
func Start(log *slog.Logger) *Engine {
	e := &Engine{log: log, reqs: make(chan func()), done: make(chan struct{}), threads: performanceCores()}
	ready := make(chan struct{})
	go e.run(ready)
	<-ready
	return e
}

func (e *Engine) run(ready chan<- struct{}) {
	runtime.LockOSThread()
	defer close(e.done)
	C.cf_log_init()
	close(ready)
	for f := range e.reqs {
		if f == nil {
			break
		}
		f()
	}
	e.free()
}

// do runs f on the actor and waits for it. After Close it does nothing.
func (e *Engine) do(f func()) {
	finished := make(chan struct{})
	select {
	case e.reqs <- func() { defer close(finished); f() }:
	case <-e.done:
		return
	}
	select {
	case <-finished:
	case <-e.done:
	}
}

// Close frees the models and stops the actor.
func (e *Engine) Close() {
	select {
	case e.reqs <- nil:
	case <-e.done:
	}
	<-e.done
}

// Version is the whisper.cpp version linked in.
func (e *Engine) Version() string {
	var v string
	e.do(func() { v = C.GoString(C.whisper_version()) })
	return v
}

// Load loads the whisper model at path and the embedded VAD, then runs whisper once over
// a second of silence so the first phrase does not pay for Metal's pipeline compilation.
func (e *Engine) Load(path string) error {
	if fi, err := os.Stat(path); err != nil {
		return fmt.Errorf("model: %w", err)
	} else if !fi.Mode().IsRegular() {
		return fmt.Errorf("model: %s is not a file", path)
	}
	var err error
	e.do(func() { err = e.load(path) })
	return err
}

func (e *Engine) load(path string) error {
	if e.ctx != nil {
		return nil
	}
	cpath := C.CString(path)
	defer C.free(unsafe.Pointer(cpath))
	ctx := C.cf_init(cpath)
	if ctx == nil {
		return fmt.Errorf("whisper could not load the model %s", path)
	}
	e.ctx = ctx
	if err := e.loadVAD(); err != nil {
		e.free()
		return err
	}
	warm := make([]float32, 16000)
	if rc := C.cf_full(e.ctx, (*C.float)(unsafe.Pointer(&warm[0])), C.int(len(warm)), C.int(e.threads), nil); rc != 0 {
		e.free()
		return fmt.Errorf("whisper warm-up failed (%d)", int(rc))
	}
	e.log.Info("dictate: model loaded", "model", path, "threads", e.threads)
	return nil
}

func (e *Engine) loadVAD() error {
	if e.vad != nil {
		return nil
	}
	e.vad = C.cf_vad_init((*C.char)(unsafe.Pointer(&sileroModel[0])), C.size_t(len(sileroModel)), 1)
	if e.vad == nil {
		return errors.New("whisper could not load the embedded VAD model")
	}
	return nil
}

// Unload frees both models.
func (e *Engine) Unload() { e.do(e.free) }

func (e *Engine) free() {
	if e.vad != nil {
		C.whisper_vad_free(e.vad)
		e.vad = nil
	}
	if e.ctx != nil {
		C.whisper_free(e.ctx)
		e.ctx = nil
	}
}

// Loaded reports whether a model is resident.
func (e *Engine) Loaded() bool {
	var ok bool
	e.do(func() { ok = e.ctx != nil })
	return ok
}

// ResetVAD clears the VAD's LSTM state.
func (e *Engine) ResetVAD() {
	e.do(func() {
		if e.vad != nil {
			C.whisper_vad_reset_state(e.vad)
		}
	})
}

// VAD scores samples (a multiple of 512) window by window, keeping the LSTM state.
func (e *Engine) VAD(samples []float32) ([]float32, error) {
	if len(samples) == 0 {
		return nil, nil
	}
	var probs []float32
	var err error
	e.do(func() {
		if e.vad == nil {
			err = errors.New("the VAD is not loaded")
			return
		}
		if !C.whisper_vad_detect_speech_no_reset(e.vad, (*C.float)(unsafe.Pointer(&samples[0])), C.int(len(samples))) {
			err = errors.New("whisper_vad_detect_speech failed")
			return
		}
		n := int(C.whisper_vad_n_probs(e.vad))
		probs = append([]float32(nil), unsafe.Slice((*float32)(unsafe.Pointer(C.whisper_vad_probs(e.vad))), n)...)
	})
	return probs, err
}

// Transcribe runs whisper over one phrase.
func (e *Engine) Transcribe(samples []float32, prompt string) (string, error) {
	if len(samples) == 0 {
		return "", nil
	}
	var text string
	var err error
	e.do(func() {
		if e.ctx == nil {
			err = errors.New("the model is not loaded")
			return
		}
		var cprompt *C.char
		if prompt != "" {
			cprompt = C.CString(prompt)
			defer C.free(unsafe.Pointer(cprompt))
		}
		if rc := C.cf_full(e.ctx, (*C.float)(unsafe.Pointer(&samples[0])), C.int(len(samples)), C.int(e.threads), cprompt); rc != 0 {
			err = fmt.Errorf("whisper_full failed (%d)", int(rc))
			return
		}
		var b strings.Builder
		for i := range int(C.whisper_full_n_segments(e.ctx)) {
			b.WriteString(C.GoString(C.whisper_full_get_segment_text(e.ctx, C.int(i))))
		}
		text = strings.TrimSpace(b.String())
	})
	return text, err
}

// RSS is the process's physical footprint.
func (e *Engine) RSS() uint64 {
	var n uint64
	e.do(func() { n = uint64(C.cf_footprint()) })
	return n
}

// performanceCores is the number of performance cores (hw.perflevel0), the thread count
// whisper runs fastest with on Apple silicon; half the CPUs when sysctl does not say.
func performanceCores() int {
	if n, err := syscall.SysctlUint32("hw.perflevel0.physicalcpu"); err == nil && n > 0 {
		return int(n)
	}
	return max(1, runtime.NumCPU()/2)
}
