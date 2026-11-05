package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework AVFoundation -framework AudioToolbox -framework CoreAudio -framework CoreFoundation -framework Foundation
#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <CoreAudio/CoreAudio.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "mic_ring_darwin.h"

// The microphone for dictation (docs/notes/dictation-auhal.md). Go calls these from one
// goroutine (avMicrophone's actor). Capture is an input-only AUHAL unit: AVAudioEngine woke
// Bluetooth headsets, reconfigured when moved to a device, and could not be released safely.
// Nothing that runs by itself enters Go. The permission reply, the drain queue and the
// hardware watch write to pipes that Go reads, and the realtime input callback only reaches
// the drain queue, through a ring. Every write end is a dup the writing side owns, with
// SIGPIPE off. AVFoundation is left with the permission calls and the converter.

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

// CFMicSink is a pipe's write end, closed (fd -1) by cfMicClose under mu. The watch block
// retains its sink, so a notification delivered after the stop finds -1, not freed memory.
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

// cfMicFail sets *err (malloc'd) to what went wrong, with CoreAudio's status when there is one.
static void cfMicFail(char** err, const char* what, OSStatus rc) {
	char* text = NULL;
	if (rc == noErr) {
		*err = strdup(what);
	} else if (asprintf(&text, "%s (%d)", what, (int)rc) >= 0) {
		*err = text;
	} else {
		*err = strdup(what);
	}
}

// How much the IO thread can hand over. cfMicScratchFrames is the largest callback taken (a
// larger one is dropped and counted), cfMicRingFrames is 5 s at 48 kHz and over 1 s at 192 kHz
// (a power of two), cfMicChunkFrames is the most one conversion takes (a large one sat in the
// converter as latency, up to 250 ms at 8 kHz), and cfMicDrainNanos is how often the drain runs.
enum {
	cfMicScratchFrames = 16384,
	cfMicRingFrames = 1 << 18,
	cfMicChunkFrames = 2048,
};
static const uint64_t cfMicDrainNanos = 20 * NSEC_PER_MSEC;

// cfMicCounts is what a capture did, for the log. Go reads it from cfMicStop.
typedef struct {
	double rate; // the device's, as opened
	unsigned long long frames; // taken from the device
	unsigned long long dropped; // lost because the ring was full or a callback too large
	unsigned long long renderErrors;
	unsigned long long convertErrors;
} cfMicCounts;

// cfMic is an open microphone. Who touches what while it runs: the IO thread has unit, ring,
// scratch and its counters; the drain queue has ring, conv, in, out and sink; the watch block
// has only what it captured, never this struct. Nothing here is freed before all of them have
// stopped (cfMicClose).
typedef struct {
	AudioUnit unit;
	BOOL initialized;
	BOOL started;
	AudioObjectID device;

	cfMicRing ring;
	float* scratch;
	_Atomic uint64_t frames;
	_Atomic uint64_t oversized;
	_Atomic uint64_t renderErrors;

	AVAudioConverter* conv;
	AVAudioPCMBuffer* in;
	AVAudioPCMBuffer* out;
	CFMicSink* sink;
	void* drainQueue; // dispatch_queue_t; cgo cannot size an id field
	void* timer;      // dispatch_source_t
	uint64_t convertErrors;

	CFMicSink* change;
	void* watchQueue; // dispatch_queue_t
	void* watch;      // AudioObjectPropertyListenerBlock, copied
	AudioObjectID watched[3]; // the objects of watchedSelectors, in order
	AudioObjectPropertySelector watchedSelectors[3];
	int watchedCount;

	double rate;
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

// cfMicInput is the unit's input callback, on the realtime IO thread: it must not allocate,
// lock, or call anything that can block. It takes the samples and hands them to the ring.
static OSStatus cfMicInput(void* refcon, AudioUnitRenderActionFlags* flags, const AudioTimeStamp* when, UInt32 bus, UInt32 frames, AudioBufferList* unused) {
	cfMic* m = refcon;
	if (frames > cfMicScratchFrames) {
		atomic_fetch_add_explicit(&m->oversized, frames, memory_order_relaxed);
		return noErr;
	}
	AudioBufferList list = {1, {{1, frames * (UInt32)sizeof(float), m->scratch}}};
	if (AudioUnitRender(m->unit, flags, when, bus, frames, &list) != noErr) {
		// Expected for a moment while the device reconfigures; a watch reports that.
		atomic_fetch_add_explicit(&m->renderErrors, 1, memory_order_relaxed);
		return noErr;
	}
	atomic_fetch_add_explicit(&m->frames, frames, memory_order_relaxed);
	cfMicRingWrite(&m->ring, m->scratch, frames);
	return noErr;
}

// cfMicDrain runs on the drain queue: it empties the ring through the converter into the sink.
// The converter may keep reading in after it returns, if out filled first, so in is not
// refilled until the converter has come back for more and been told NoDataNow. That took a
// stall to show: a large chunk after one, then clicks and lost samples.
static void cfMicDrain(cfMic* m) {
	@autoreleasepool {
		AVAudioPCMBuffer* in = m->in;
		for (;;) {
			size_t n = cfMicRingRead(&m->ring, in.floatChannelData[0], cfMicChunkFrames);
			if (n == 0) return;
			in.frameLength = (AVAudioFrameCount)n;
			__block BOOL fed = NO;
			AVAudioConverterOutputStatus status;
			do {
				m->out.frameLength = 0;
				NSError* cerr = nil;
				// NoDataNow (not EndOfStream) keeps the resampler's state for the next buffer.
				status = [m->conv convertToBuffer:m->out error:&cerr withInputFromBlock:^AVAudioBuffer*(AVAudioPacketCount count, AVAudioConverterInputStatus* state) {
					if (fed) {
						*state = AVAudioConverterInputStatus_NoDataNow;
						return nil;
					}
					fed = YES;
					*state = AVAudioConverterInputStatus_HaveData;
					return in;
				}];
				if (status == AVAudioConverterOutputStatus_Error) {
					m->convertErrors++;
				} else if (m->out.frameLength > 0) {
					cfMicSinkWrite(m->sink, (const char*)m->out.int16ChannelData[0], (size_t)m->out.frameLength * 2);
				}
			} while (status == AVAudioConverterOutputStatus_HaveData && m->out.frameLength > 0);
		}
	}
}

// cfMicPipeline makes everything between the IO thread and fd, and starts the drain: samples at
// this rate leave as 16 kHz mono int16. It opens no device.
static BOOL cfMicPipeline(cfMic* m, int fd, double rate, char** err) {
	if (cfMicRingInit(&m->ring, cfMicRingFrames) != 0) {
		cfMicFail(err, "out of memory", noErr);
		return NO;
	}
	m->scratch = malloc(cfMicScratchFrames * sizeof(float));
	if (m->scratch == NULL) {
		cfMicFail(err, "out of memory", noErr);
		return NO;
	}
	memset(m->scratch, 0, cfMicScratchFrames * sizeof(float)); // no page fault on the IO thread
	AVAudioFormat* inFmt = [[[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatFloat32 sampleRate:rate channels:1 interleaved:NO] autorelease];
	AVAudioFormat* outFmt = [[[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatInt16 sampleRate:16000 channels:1 interleaved:YES] autorelease];
	if (inFmt != nil && outFmt != nil) m->conv = [[AVAudioConverter alloc] initFromFormat:inFmt toFormat:outFmt];
	if (m->conv == nil) {
		cfMicFail(err, "cannot convert the microphone's format to 16 kHz mono", noErr);
		return NO;
	}
	m->in = [[AVAudioPCMBuffer alloc] initWithPCMFormat:inFmt frameCapacity:cfMicChunkFrames];
	m->out = [[AVAudioPCMBuffer alloc] initWithPCMFormat:outFmt frameCapacity:(AVAudioFrameCount)(cfMicChunkFrames * (16000.0 / rate)) + 64];
	if (m->in == nil || m->out == nil) {
		cfMicFail(err, "out of memory", noErr);
		return NO;
	}
	m->sink = cfMicSinkNew(fd);
	if (m->sink->fd < 0) {
		cfMicFail(err, "cannot keep the audio pipe", noErr);
		return NO;
	}
	dispatch_queue_attr_t attr = dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL, QOS_CLASS_USER_INITIATED, 0);
	dispatch_queue_t queue = dispatch_queue_create("dev.alexwaumann.codefoundry.mic.drain", attr);
	m->drainQueue = (void*)queue;
	dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, queue);
	m->timer = (void*)timer;
	dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, (int64_t)cfMicDrainNanos), cfMicDrainNanos, 5 * NSEC_PER_MSEC);
	dispatch_source_set_event_handler(timer, ^{
		cfMicDrain(m);
	});
	dispatch_resume(timer);
	return YES;
}

static AudioObjectPropertyAddress cfMicAddress(AudioObjectPropertySelector selector) {
	AudioObjectPropertyAddress a = {selector, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
	return a;
}

// cfMicRead reads a fixed-size property, YES if it could.
static BOOL cfMicRead(AudioObjectID object, AudioObjectPropertySelector selector, void* value, UInt32 size) {
	AudioObjectPropertyAddress a = cfMicAddress(selector);
	return AudioObjectGetPropertyData(object, &a, 0, NULL, &size, value) == noErr;
}

// cfMicDevice is the device with this UID, or with NULL the default input; 0 with *err if none.
static AudioObjectID cfMicDevice(const char* text, char** err) {
	AudioObjectID device = 0;
	if (text == NULL) {
		if (!cfMicRead(kAudioObjectSystemObject, kAudioHardwarePropertyDefaultInputDevice, &device, sizeof device) || device == 0) {
			cfMicFail(err, "no microphone", noErr);
			return 0;
		}
		return device;
	}
	CFStringRef uid = CFStringCreateWithCString(kCFAllocatorDefault, text, kCFStringEncodingUTF8);
	if (uid == NULL) {
		cfMicFail(err, "a bad device UID", noErr);
		return 0;
	}
	AudioObjectPropertyAddress a = cfMicAddress(kAudioHardwarePropertyTranslateUIDToDevice);
	UInt32 size = sizeof device;
	OSStatus rc = AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, sizeof uid, &uid, &size, &device);
	CFRelease(uid);
	if (rc != noErr || device == 0) {
		cfMicFail(err, "that input is not connected", noErr);
		return 0;
	}
	return device;
}

// cfMicMoved says whether the hardware really differs from what was opened. Being told a
// property changed is not enough: a notification can repeat what we already know, and the
// watch must stay silent then, or a settled device would burn through the reopen limit.
static BOOL cfMicMoved(AudioObjectID device, Float64 rate, BOOL followDefault) {
	UInt32 alive = 0;
	if (!cfMicRead(device, kAudioDevicePropertyDeviceIsAlive, &alive, sizeof alive) || alive == 0) return YES;
	Float64 now = 0;
	if (rate > 0 && cfMicRead(device, kAudioDevicePropertyNominalSampleRate, &now, sizeof now) && now != rate) return YES;
	AudioObjectID current = 0;
	if (followDefault && cfMicRead(kAudioObjectSystemObject, kAudioHardwarePropertyDefaultInputDevice, &current, sizeof current) && current != device) return YES;
	return NO;
}

// cfMicAddWatch listens for one property on the watch queue. NO with *err if it cannot.
static BOOL cfMicAddWatch(cfMic* m, AudioObjectID object, AudioObjectPropertySelector selector, char** err) {
	AudioObjectPropertyAddress a = cfMicAddress(selector);
	OSStatus rc = AudioObjectAddPropertyListenerBlock(object, &a, (dispatch_queue_t)m->watchQueue, (AudioObjectPropertyListenerBlock)m->watch);
	if (rc != noErr) {
		cfMicFail(err, "cannot watch the microphone", rc);
		return NO;
	}
	m->watched[m->watchedCount] = object;
	m->watchedSelectors[m->watchedCount] = selector;
	m->watchedCount++;
	return YES;
}

// cfMicWatch starts writing a byte to changeFd when the hardware under this capture moves: the
// device goes away or changes rate, or the default input moves if that is what we follow. These
// are the only properties watched. A pinned input hears nothing of the default, so a headset
// merely being there cannot reach it, and nothing our own start does on a settled device shows
// up in cfMicMoved. The block holds no pointer to m: CoreAudio may have one more queued
// when the listener goes, and the sink it retains then reads closed.
static BOOL cfMicWatch(cfMic* m, int changeFd, Float64 nominal, BOOL followDefault, char** err) {
	CFMicSink* change = cfMicSinkNew(changeFd);
	m->change = change;
	if (change->fd < 0) {
		cfMicFail(err, "cannot keep the change pipe", noErr);
		return NO;
	}
	fcntl(change->fd, F_SETFL, fcntl(change->fd, F_GETFL) | O_NONBLOCK);
	m->watchQueue = (void*)dispatch_queue_create("dev.alexwaumann.codefoundry.mic.watch", DISPATCH_QUEUE_SERIAL);
	AudioObjectID device = m->device;
	AudioObjectPropertyListenerBlock block = ^(UInt32 count, const AudioObjectPropertyAddress* addresses) {
		if (cfMicMoved(device, nominal, followDefault)) cfMicSinkWrite(change, "c", 1);
	};
	m->watch = (void*)[block copy];
	if (!cfMicAddWatch(m, device, kAudioDevicePropertyDeviceIsAlive, err)) return NO;
	if (!cfMicAddWatch(m, device, kAudioDevicePropertyNominalSampleRate, err)) return NO;
	if (followDefault && !cfMicAddWatch(m, kAudioObjectSystemObject, kAudioHardwarePropertyDefaultInputDevice, err)) return NO;
	return YES;
}

// cfMicOpen does cfMicStart's work on a zeroed m. On NO, *err is set and cfMicClose undoes the
// rest. The unit is input-only, so nothing here asks for the default output, or for the output
// side of a headset.
static BOOL cfMicOpen(cfMic* m, int fd, int changeFd, const char* uid, char** err) {
	m->device = cfMicDevice(uid, err);
	if (m->device == 0) return NO;

	AudioComponentDescription desc = {kAudioUnitType_Output, kAudioUnitSubType_HALOutput, kAudioUnitManufacturer_Apple, 0, 0};
	AudioComponent component = AudioComponentFindNext(NULL, &desc);
	if (component == NULL) {
		cfMicFail(err, "no audio input unit", noErr);
		return NO;
	}
	OSStatus rc = AudioComponentInstanceNew(component, &m->unit);
	if (rc != noErr) {
		m->unit = NULL;
		cfMicFail(err, "cannot make the audio input unit", rc);
		return NO;
	}
	UInt32 on = 1, off = 0;
	if ((rc = AudioUnitSetProperty(m->unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &on, sizeof on)) != noErr) {
		cfMicFail(err, "the audio unit refused input", rc);
		return NO;
	}
	if ((rc = AudioUnitSetProperty(m->unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &off, sizeof off)) != noErr) {
		cfMicFail(err, "the audio unit refused to drop output", rc);
		return NO;
	}
	// Always explicit: left alone, the unit would follow the default by itself.
	if ((rc = AudioUnitSetProperty(m->unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &m->device, sizeof m->device)) != noErr) {
		cfMicFail(err, "the audio unit refused that device", rc);
		return NO;
	}
	// The device's side of the input element. The client side must keep its rate: an input
	// unit has no sample rate converter of its own. That is AVAudioConverter's job, later.
	AudioStreamBasicDescription device = {0};
	UInt32 size = sizeof device;
	rc = AudioUnitGetProperty(m->unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 1, &device, &size);
	if (rc != noErr || device.mSampleRate <= 0 || device.mChannelsPerFrame == 0) {
		cfMicFail(err, "no microphone", rc);
		return NO;
	}
	m->rate = device.mSampleRate;
	AudioStreamBasicDescription client = {device.mSampleRate, kAudioFormatLinearPCM, kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked, sizeof(float), 1, sizeof(float), 1, 32, 0};
	if ((rc = AudioUnitSetProperty(m->unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, &client, sizeof client)) != noErr) {
		cfMicFail(err, "the audio unit refused the format", rc);
		return NO;
	}
	if (!cfMicPipeline(m, fd, m->rate, err)) return NO;
	AURenderCallbackStruct callback = {cfMicInput, m};
	if ((rc = AudioUnitSetProperty(m->unit, kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global, 0, &callback, sizeof callback)) != noErr) {
		cfMicFail(err, "the audio unit refused the callback", rc);
		return NO;
	}
	if ((rc = AudioUnitInitialize(m->unit)) != noErr) {
		cfMicFail(err, "the audio unit did not initialize", rc);
		return NO;
	}
	m->initialized = YES;
	// Before the start, so that a watch that fails never wakes the device.
	Float64 nominal = 0;
	if (!cfMicRead(m->device, kAudioDevicePropertyNominalSampleRate, &nominal, sizeof nominal)) nominal = 0;
	BOOL followDefault = uid == NULL;
	if (!cfMicWatch(m, changeFd, nominal, followDefault, err)) return NO;
	if ((rc = AudioOutputUnitStart(m->unit)) != noErr) {
		cfMicFail(err, "the microphone did not start", rc);
		return NO;
	}
	m->started = YES;
	// Whatever moved between reading the device and the listeners going on has no notification.
	AudioObjectPropertyAddress none = {0};
	((AudioObjectPropertyListenerBlock)m->watch)(0, &none);
	return YES;
}

// cfMicClose undoes what has been made of m, in order, and frees it. When it returns nothing
// is left running: not the IO thread's callback, the drain or a watch. Order matters: the
// watches go first so that stopping cannot report itself, and the unit stops before the ring
// and buffers the callback writes to can go. counts, if not NULL, gets the totals.
static void cfMicClose(cfMic* m, cfMicCounts* counts) {
	for (int i = 0; i < m->watchedCount; i++) {
		AudioObjectPropertyAddress a = cfMicAddress(m->watchedSelectors[i]);
		AudioObjectRemovePropertyListenerBlock(m->watched[i], &a, (dispatch_queue_t)m->watchQueue, (AudioObjectPropertyListenerBlock)m->watch);
	}
	if (m->watchQueue != NULL) dispatch_sync((dispatch_queue_t)m->watchQueue, ^{});
	if (m->started) AudioOutputUnitStop(m->unit);
	if (m->initialized) AudioUnitUninitialize(m->unit);
	if (m->timer != NULL) {
		dispatch_source_cancel((dispatch_source_t)m->timer);
		// A drain in progress finishes first, and cancelling means no other starts.
		dispatch_sync((dispatch_queue_t)m->drainQueue, ^{});
		dispatch_release((dispatch_source_t)m->timer);
	}
	if (m->drainQueue != NULL) dispatch_release((dispatch_queue_t)m->drainQueue);
	if (m->sink != nil) cfMicSinkClose(m->sink);
	if (m->change != nil) cfMicSinkClose(m->change);
	if (m->unit != NULL) AudioComponentInstanceDispose(m->unit);
	if (counts != NULL) {
		counts->rate = m->rate;
		counts->frames = atomic_load_explicit(&m->frames, memory_order_relaxed);
		counts->dropped = atomic_load_explicit(&m->ring.dropped, memory_order_relaxed) + atomic_load_explicit(&m->oversized, memory_order_relaxed);
		counts->renderErrors = atomic_load_explicit(&m->renderErrors, memory_order_relaxed);
		counts->convertErrors = m->convertErrors;
	}
	if (m->watch != NULL) [(id)m->watch release];
	if (m->watchQueue != NULL) dispatch_release((dispatch_queue_t)m->watchQueue);
	[m->sink release];
	[m->change release];
	[m->conv release];
	[m->in release];
	[m->out release];
	cfMicRingFree(&m->ring);
	free(m->scratch);
	free(m);
}

// cfMicStart opens an input with an input-only AUHAL unit, the device with UID uid or, with NULL,
// the default as it is now, and writes its audio to fd (duplicated) as 16 kHz mono int16
// little-endian. The hardware moving under it (cfMicWatch) writes a byte to changeFd (duplicated,
// non-blocking). NULL with *err (malloc'd) on failure, with everything it made gone again.
static cfMic* cfMicStart(int fd, int changeFd, const char* uid, char** err) {
	@autoreleasepool {
		cfMic* m = calloc(1, sizeof *m);
		if (m == NULL) {
			cfMicFail(err, "out of memory", noErr);
			return NULL;
		}
		if (!cfMicOpen(m, fd, changeFd, uid, err)) {
			cfMicClose(m, NULL);
			return NULL;
		}
		return m;
	}
}

// cfMicStop closes the microphone and both pipes (the readers then see EOF), and frees m. It
// returns with nothing left running, and fills counts.
static void cfMicStop(cfMic* m, cfMicCounts* counts) {
	@autoreleasepool {
		cfMicClose(m, counts);
	}
}
*/
import "C"

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"runtime"
	"sync"
	"unsafe"
)

// avMicrophone is the microphone through CoreAudio, with AVFoundation for the permission.
// Every C call runs on one goroutine locked to its OS thread (the terminal actor's pattern);
// the methods hand it closures and wait.
type avMicrophone struct {
	reqs chan func()
	log  *slog.Logger
}

// newAVMicrophone starts the actor. It touches the audio frameworks only when asked.
func newAVMicrophone(log *slog.Logger) *avMicrophone {
	m := &avMicrophone{reqs: make(chan func()), log: log}
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

// Inputs is the Mac's inputs now.
func (m *avMicrophone) Inputs() inputList { return listInputs() }

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

// Start opens the input with this UID, or the system default with "".
func (m *avMicrophone) Start(uid string) (micCapture, error) {
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
	var cuid *C.char
	if uid != "" {
		cuid = C.CString(uid)
		defer C.free(unsafe.Pointer(cuid))
	}
	m.do(func() { mic = C.cfMicStart(C.int(w.Fd()), C.int(cw.Fd()), cuid, &cerr) })
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

// avCapture is an open AUHAL capture.
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
		var n C.cfMicCounts
		c.m.do(func() { C.cfMicStop(c.mic, &n) })
		c.mic = nil
		c.m.log.Info("dictation: capture closed", "rate", float64(n.rate), "frames", uint64(n.frames),
			"dropped", uint64(n.dropped), "render_errors", uint64(n.renderErrors), "convert_errors", uint64(n.convertErrors))
	})
}
