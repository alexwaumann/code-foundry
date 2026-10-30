package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework AVFoundation -framework Foundation
#import <AVFoundation/AVFoundation.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

// The microphone for dictation (docs/notes/dictation-3-host.md). Go calls these from one
// goroutine (avMicrophone's actor). AVFoundation's callbacks (the permission reply, the
// input tap on the audio thread) never enter Go: they write to a pipe that Go reads.
// Every write end is a dup the callback side owns, with SIGPIPE off.

// cfMicPermission is AVCaptureDevice's authorization status for audio:
// 0 not determined, 1 restricted, 2 denied, 3 authorized.
static int cfMicPermission(void) {
	return (int)[AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
}

// cfMicRequestAccess asks for the microphone (the TCC prompt when not determined) and
// writes one byte to fd when macOS answers: 1 granted, 0 denied. fd is duplicated; the
// caller closes its own.
static int cfMicRequestAccess(int fd) {
	int w = dup(fd);
	if (w < 0) return -1;
	fcntl(w, F_SETNOSIGPIPE, 1);
	[AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL granted) {
		char b = granted ? 1 : 0;
		(void)write(w, &b, 1);
		close(w);
	}];
	return 0;
}

// CFMicSink is the tap's way out: the pipe's write end, closed (fd -1) by cfMicStop
// under mu. The tap block retains it, so a tap still running after the stop finds -1
// instead of freed memory.
@interface CFMicSink : NSObject {
@public
	pthread_mutex_t mu;
	int fd;
}
@end

@implementation CFMicSink
- (void)dealloc {
	if (fd >= 0) close(fd);
	pthread_mutex_destroy(&mu);
	[super dealloc];
}
@end

// cfMicSinkWrite writes n bytes, all of them unless the pipe was closed.
static void cfMicSinkWrite(CFMicSink* s, const char* p, size_t n) {
	pthread_mutex_lock(&s->mu);
	while (s->fd >= 0 && n > 0) {
		ssize_t k = write(s->fd, p, n);
		if (k < 0) {
			if (errno == EINTR) continue;
			break;
		}
		p += k;
		n -= (size_t)k;
	}
	pthread_mutex_unlock(&s->mu);
}

// cfMic is an open microphone: the engine, the audio sink, the change sink and the
// configuration-change observer (all retained).
typedef struct {
	AVAudioEngine* engine;
	CFMicSink* sink;
	CFMicSink* change;
	void* observer; // id; cgo cannot size an id field
} cfMic;

static CFMicSink* cfMicSinkNew(int fd) {
	CFMicSink* s = [[CFMicSink alloc] init];
	pthread_mutex_init(&s->mu, NULL);
	s->fd = dup(fd);
	if (s->fd >= 0) fcntl(s->fd, F_SETNOSIGPIPE, 1);
	return s;
}

static void cfMicSinkClose(CFMicSink* s) {
	pthread_mutex_lock(&s->mu);
	if (s->fd >= 0) close(s->fd);
	s->fd = -1;
	pthread_mutex_unlock(&s->mu);
}

// cfMicStart opens the default input with AVAudioEngine and writes its audio to fd
// (duplicated) as 16 kHz mono int16 little-endian, converted by AVAudioConverter on the
// tap's thread. A configuration change (AVAudioEngineConfigurationChangeNotification:
// a headset connected, the default input switched; the engine has stopped) writes one
// byte to changeFd (duplicated, non-blocking). NULL with *err (malloc'd) on failure.
static cfMic* cfMicStart(int fd, int changeFd, char** err) {
	@autoreleasepool {
		AVAudioEngine* engine = [[AVAudioEngine alloc] init];
		AVAudioInputNode* input = [engine inputNode];
		AVAudioFormat* inFmt = [input outputFormatForBus:0];
		if (inFmt.sampleRate <= 0 || inFmt.channelCount == 0) {
			[engine release];
			*err = strdup("no microphone");
			return NULL;
		}
		AVAudioFormat* outFmt = [[[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatInt16 sampleRate:16000 channels:1 interleaved:YES] autorelease];
		AVAudioConverter* conv = [[[AVAudioConverter alloc] initFromFormat:inFmt toFormat:outFmt] autorelease];
		if (conv == nil) {
			[engine release];
			*err = strdup("cannot convert the microphone's format to 16 kHz mono");
			return NULL;
		}
		conv.downmix = YES;
		CFMicSink* sink = cfMicSinkNew(fd);
		double ratio = 16000.0 / inFmt.sampleRate;
		// ~100 ms at 48 kHz; AVAudioEngine treats the size as a hint. The variant with an
		// error parameter is macOS 27 and up; this one still works there.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
		[input installTapOnBus:0 bufferSize:4800 format:inFmt block:^(AVAudioPCMBuffer* buf, AVAudioTime* when) {
			AVAudioFrameCount cap = (AVAudioFrameCount)(buf.frameLength * ratio) + 64;
			AVAudioPCMBuffer* out = [[AVAudioPCMBuffer alloc] initWithPCMFormat:outFmt frameCapacity:cap];
			__block BOOL fed = NO;
			NSError* cerr = nil;
			// NoDataNow (not EndOfStream) keeps the resampler's state for the next buffer.
			[conv convertToBuffer:out error:&cerr withInputFromBlock:^AVAudioBuffer*(AVAudioPacketCount n, AVAudioConverterInputStatus* status) {
				if (fed) {
					*status = AVAudioConverterInputStatus_NoDataNow;
					return nil;
				}
				fed = YES;
				*status = AVAudioConverterInputStatus_HaveData;
				return buf;
			}];
			if (out.frameLength > 0) {
				cfMicSinkWrite(sink, (const char*)out.int16ChannelData[0], (size_t)out.frameLength * 2);
			}
			[out release];
		}];
#pragma clang diagnostic pop
		[engine prepare];
		NSError* serr = nil;
		if (![engine startAndReturnError:&serr]) {
			[input removeTapOnBus:0];
			*err = strdup(serr != nil ? serr.localizedDescription.UTF8String : "the audio engine did not start");
			[engine release];
			[sink release];
			return NULL;
		}
		CFMicSink* change = cfMicSinkNew(changeFd);
		if (change->fd >= 0) fcntl(change->fd, F_SETFL, fcntl(change->fd, F_GETFL) | O_NONBLOCK);
		id observer = [[NSNotificationCenter defaultCenter] addObserverForName:AVAudioEngineConfigurationChangeNotification object:engine queue:nil usingBlock:^(NSNotification* note) {
			cfMicSinkWrite(change, "c", 1);
		}];
		cfMic* m = calloc(1, sizeof *m);
		m->engine = engine;
		m->sink = sink;
		m->change = change;
		m->observer = (void*)[observer retain];
		return m;
	}
}

// cfMicStop closes the microphone and both pipes (the readers then see EOF), and frees m.
static void cfMicStop(cfMic* m) {
	@autoreleasepool {
		[[NSNotificationCenter defaultCenter] removeObserver:(id)m->observer];
		[(id)m->observer release];
		[[m->engine inputNode] removeTapOnBus:0];
		[m->engine stop];
		cfMicSinkClose(m->sink);
		cfMicSinkClose(m->change);
		[m->sink release];
		[m->change release];
		[m->engine release];
		free(m);
	}
}
*/
import "C"

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"sync"
	"unsafe"
)

// avMicrophone is the microphone through AVFoundation. Every C call runs on one
// goroutine locked to its OS thread (the terminal actor's pattern); the methods hand it
// closures and wait.
type avMicrophone struct {
	reqs chan func()
}

// newAVMicrophone starts the actor. It touches AVFoundation only when asked.
func newAVMicrophone() *avMicrophone {
	m := &avMicrophone{reqs: make(chan func())}
	go m.loop()
	return m
}

func (m *avMicrophone) loop() {
	runtime.LockOSThread()
	for f := range m.reqs {
		f()
	}
}

// do runs f on the actor and waits for it.
func (m *avMicrophone) do(f func()) {
	done := make(chan struct{})
	m.reqs <- func() {
		defer close(done)
		f()
	}
	<-done
}

// Permission is the microphone permission now.
func (m *avMicrophone) Permission() micPermission {
	var status C.int
	m.do(func() { status = C.cfMicPermission() })
	switch status {
	case 1, 2:
		return micDenied
	case 3:
		return micGranted
	}
	return micUndetermined
}

// RequestAccess asks macOS for the microphone. The answer comes on a pipe: the
// completion handler runs on a queue of AVFoundation's and must not call into Go.
func (m *avMicrophone) RequestAccess(ctx context.Context) (bool, error) {
	r, w, err := os.Pipe()
	if err != nil {
		return false, fmt.Errorf("microphone permission: %w", err)
	}
	defer func() { _ = r.Close() }()
	var rc C.int
	m.do(func() { rc = C.cfMicRequestAccess(C.int(w.Fd())) })
	_ = w.Close()
	if rc != 0 {
		return false, errors.New("microphone permission: dup failed")
	}
	got := make(chan byte, 1)
	go func() {
		var b [1]byte
		if _, err := io.ReadFull(r, b[:]); err != nil {
			close(got)
			return
		}
		got <- b[0]
	}()
	select {
	case <-ctx.Done():
		return false, ctx.Err()
	case b, ok := <-got:
		if !ok {
			return false, errors.New("microphone permission: no answer")
		}
		return b == 1, nil
	}
}

// Start opens the microphone.
func (m *avMicrophone) Start() (micCapture, error) {
	r, w, err := os.Pipe()
	if err != nil {
		return nil, fmt.Errorf("open microphone: %w", err)
	}
	cr, cw, err := os.Pipe()
	if err != nil {
		_, _ = r.Close(), w.Close()
		return nil, fmt.Errorf("open microphone: %w", err)
	}
	var (
		mic  *C.cfMic
		cerr *C.char
	)
	m.do(func() { mic = C.cfMicStart(C.int(w.Fd()), C.int(cw.Fd()), &cerr) })
	// The C side holds its own copies of the write ends; it closes them on stop, which
	// ends the readers below.
	_, _ = w.Close(), cw.Close()
	if mic == nil {
		_, _ = r.Close(), cr.Close()
		msg := C.GoString(cerr)
		C.free(unsafe.Pointer(cerr))
		return nil, fmt.Errorf("open microphone: %s", msg)
	}
	frames := make(chan micFrame, micFrameBuffer)
	go func() {
		pumpFrames(r, frames)
		_ = r.Close()
	}()
	changed := make(chan struct{}, 1)
	go func() {
		pumpSignals(cr, changed)
		_ = cr.Close()
	}()
	return &avCapture{m: m, mic: mic, frames: frames, changed: changed}, nil
}

// avCapture is an open AVAudioEngine capture.
type avCapture struct {
	m       *avMicrophone
	mic     *C.cfMic
	frames  chan micFrame
	changed chan struct{}
	once    sync.Once
}

func (c *avCapture) Frames() <-chan micFrame { return c.frames }

func (c *avCapture) Changed() <-chan struct{} { return c.changed }

func (c *avCapture) Stop() {
	c.once.Do(func() {
		c.m.do(func() { C.cfMicStop(c.mic) })
		c.mic = nil
	})
}
