package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework CoreAudio -framework CoreFoundation -framework IOKit
#include <CoreAudio/CoreAudio.h>
#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/IOKitLib.h>
#include <dispatch/dispatch.h>
#include <fcntl.h>
#include <stdlib.h>
#include <unistd.h>

// The Mac's input devices (docs/notes/dictation-microphone.md). Reading these opens nothing and
// needs no permission. CoreAudio's property calls are thread-safe.

static AudioObjectPropertyAddress cfInAddress(AudioObjectPropertySelector selector, AudioObjectPropertyScope scope) {
	AudioObjectPropertyAddress a = {selector, scope, kAudioObjectPropertyElementMain};
	return a;
}

static UInt32 cfInU32(AudioObjectID object, AudioObjectPropertySelector selector, AudioObjectPropertyScope scope) {
	AudioObjectPropertyAddress a = cfInAddress(selector, scope);
	UInt32 value = 0;
	UInt32 size = sizeof value;
	if (!AudioObjectHasProperty(object, &a) || AudioObjectGetPropertyData(object, &a, 0, NULL, &size, &value) != noErr) return 0;
	return value;
}

// cfInString is a string property, malloc'd, or NULL.
static char* cfInString(AudioObjectID object, AudioObjectPropertySelector selector) {
	AudioObjectPropertyAddress a = cfInAddress(selector, kAudioObjectPropertyScopeGlobal);
	CFStringRef s = NULL;
	UInt32 size = sizeof s;
	if (AudioObjectGetPropertyData(object, &a, 0, NULL, &size, &s) != noErr || s == NULL) return NULL;
	CFIndex cap = CFStringGetMaximumSizeForEncoding(CFStringGetLength(s), kCFStringEncodingUTF8) + 1;
	char* out = malloc((size_t)cap);
	if (out != NULL && !CFStringGetCString(s, out, cap, kCFStringEncodingUTF8)) {
		free(out);
		out = NULL;
	}
	CFRelease(s);
	return out;
}

static char* cfInUID(AudioObjectID device) { return cfInString(device, kAudioDevicePropertyDeviceUID); }
static char* cfInName(AudioObjectID device) { return cfInString(device, kAudioObjectPropertyName); }
static UInt32 cfInTransport(AudioObjectID device) { return cfInU32(device, kAudioDevicePropertyTransportType, kAudioObjectPropertyScopeGlobal); }
static UInt32 cfInSource(AudioObjectID device) { return cfInU32(device, kAudioDevicePropertyDataSource, kAudioObjectPropertyScopeInput); }
static AudioObjectID cfInDefault(void) { return cfInU32(kAudioObjectSystemObject, kAudioHardwarePropertyDefaultInputDevice, kAudioObjectPropertyScopeGlobal); }

// cfInIsInput: the device has input channels and is not hidden (the aggregates macOS makes).
static int cfInIsInput(AudioObjectID device) {
	if (cfInU32(device, kAudioDevicePropertyIsHidden, kAudioObjectPropertyScopeGlobal) != 0) return 0;
	AudioObjectPropertyAddress a = cfInAddress(kAudioDevicePropertyStreamConfiguration, kAudioObjectPropertyScopeInput);
	UInt32 size = 0;
	if (AudioObjectGetPropertyDataSize(device, &a, 0, NULL, &size) != noErr || size < sizeof(AudioBufferList)) return 0;
	AudioBufferList* list = malloc(size);
	if (list == NULL) return 0;
	UInt32 channels = 0;
	if (AudioObjectGetPropertyData(device, &a, 0, NULL, &size, list) == noErr) {
		for (UInt32 i = 0; i < list->mNumberBuffers; i++) channels += list->mBuffers[i].mNumberChannels;
	}
	free(list);
	return channels > 0;
}

// cfInDevices fills ids with up to cap input devices and returns how many.
static int cfInDevices(AudioObjectID* ids, int cap) {
	AudioObjectPropertyAddress a = cfInAddress(kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal);
	UInt32 size = 0;
	if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &a, 0, NULL, &size) != noErr || size == 0) return 0;
	AudioObjectID* all = malloc(size);
	if (all == NULL) return 0;
	int n = 0;
	if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, 0, NULL, &size, all) == noErr) {
		for (UInt32 i = 0; i < size / sizeof(AudioObjectID) && n < cap; i++) {
			if (cfInIsInput(all[i])) ids[n++] = all[i];
		}
	}
	free(all);
	return n;
}

// cfLidClosed: AppleClamshellState on the power root domain. Macs with no lid have none.
static int cfLidClosed(void) {
	io_service_t root = IOServiceGetMatchingService(0, IOServiceMatching("IOPMrootDomain"));
	if (root == 0) return 0;
	CFTypeRef value = IORegistryEntryCreateCFProperty(root, CFSTR("AppleClamshellState"), kCFAllocatorDefault, 0);
	IOObjectRelease(root);
	if (value == NULL) return 0;
	int closed = value == kCFBooleanTrue;
	CFRelease(value);
	return closed;
}

// cfInWatch writes a byte to fd (duplicated, non-blocking) when the devices or the default input
// change, for the life of the process. The listener never enters Go.
static int cfInWatch(int fd) {
	int w = dup(fd);
	if (w < 0) return -1;
	fcntl(w, F_SETNOSIGPIPE, 1);
	fcntl(w, F_SETFL, fcntl(w, F_GETFL) | O_NONBLOCK);
	dispatch_queue_t queue = dispatch_queue_create("code-foundry.inputs", DISPATCH_QUEUE_SERIAL);
	AudioObjectPropertyListenerBlock block = ^(UInt32 n, const AudioObjectPropertyAddress* addresses) {
		char b = 1;
		(void)write(w, &b, 1);
	};
	AudioObjectPropertyAddress devices = cfInAddress(kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal);
	AudioObjectPropertyAddress input = cfInAddress(kAudioHardwarePropertyDefaultInputDevice, kAudioObjectPropertyScopeGlobal);
	if (AudioObjectAddPropertyListenerBlock(kAudioObjectSystemObject, &devices, queue, block) != noErr) return -1;
	return AudioObjectAddPropertyListenerBlock(kAudioObjectSystemObject, &input, queue, block) == noErr ? 0 : -1;
}
*/
import "C"

import (
	"os"
	"sync"
	"unsafe"

	"github.com/alexwaumann/code-foundry/internal/dictate"
)

// inputMaxDevices bounds the list.
const inputMaxDevices = 64

// listInputs reads the Mac's inputs.
func listInputs() inputList {
	var ids [inputMaxDevices]C.AudioObjectID
	n := int(C.cfInDevices(&ids[0], inputMaxDevices))
	out := inputList{LidClosed: C.cfLidClosed() != 0}
	def := C.cfInDefault()
	for _, id := range ids[:n] {
		uid := goString(C.cfInUID(id))
		if uid == "" {
			continue
		}
		out.Devices = append(out.Devices, dictate.Input{
			UID: uid, Name: goString(C.cfInName(id)),
			Transport: inputTransport(uint32(C.cfInTransport(id)), uid, uint32(C.cfInSource(id))),
		})
		if id == def {
			out.Default = uid
		}
	}
	return out
}

// goString takes a malloc'd string.
func goString(s *C.char) string {
	if s == nil {
		return ""
	}
	defer C.free(unsafe.Pointer(s))
	return C.GoString(s)
}

// coreAudioInputs is inputHost on macOS.
type coreAudioInputs struct {
	once    sync.Once
	changed chan struct{}
}

func (*coreAudioInputs) list() inputList { return listInputs() }

func (c *coreAudioInputs) changes() <-chan struct{} {
	c.once.Do(func() {
		c.changed = make(chan struct{}, 1)
		r, w, err := os.Pipe()
		if err != nil {
			return
		}
		rc := C.cfInWatch(C.int(w.Fd()))
		_ = w.Close()
		if rc != 0 {
			_ = r.Close()
			return
		}
		go pumpSignals(r, c.changed)
	})
	return c.changed
}
