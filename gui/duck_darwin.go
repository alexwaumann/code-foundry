package main

/*
#cgo LDFLAGS: -framework CoreAudio -framework CoreFoundation
#include <CoreAudio/CoreAudio.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdlib.h>
#include <string.h>

// The default output's volumes (docs/notes/dictation-other-audio.md). CoreAudio's property calls
// are thread-safe and none needs a permission. Scope output throughout, for volumes.

static AudioObjectPropertyAddress cfVolAddress(AudioObjectPropertySelector selector, UInt32 element) {
	AudioObjectPropertyAddress a = {selector, kAudioObjectPropertyScopeOutput, element};
	return a;
}

// cfOutDefault is the default output device, 0 when there is none.
static AudioObjectID cfOutDefault(void) {
	AudioObjectPropertyAddress a = {kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
	AudioObjectID device = 0;
	UInt32 size = sizeof device;
	if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, 0, NULL, &size, &device) != noErr) return 0;
	return device;
}

// cfOutUID is the device's UID, malloc'd, or NULL.
static char* cfOutUID(AudioObjectID device) {
	AudioObjectPropertyAddress a = {kAudioDevicePropertyDeviceUID, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
	CFStringRef uid = NULL;
	UInt32 size = sizeof uid;
	if (AudioObjectGetPropertyData(device, &a, 0, NULL, &size, &uid) != noErr || uid == NULL) return NULL;
	CFIndex cap = CFStringGetMaximumSizeForEncoding(CFStringGetLength(uid), kCFStringEncodingUTF8) + 1;
	char* out = malloc((size_t)cap);
	if (out != NULL && !CFStringGetCString(uid, out, cap, kCFStringEncodingUTF8)) {
		free(out);
		out = NULL;
	}
	CFRelease(uid);
	return out;
}

// cfOutByUID is the connected device with this UID, 0 when it is not connected.
static AudioObjectID cfOutByUID(const char* text) {
	CFStringRef uid = CFStringCreateWithCString(kCFAllocatorDefault, text, kCFStringEncodingUTF8);
	if (uid == NULL) return 0;
	AudioObjectPropertyAddress a = {kAudioHardwarePropertyTranslateUIDToDevice, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
	AudioObjectID device = 0;
	UInt32 size = sizeof device;
	OSStatus rc = AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, sizeof uid, &uid, &size, &device);
	CFRelease(uid);
	return rc == noErr ? device : 0;
}

// cfOutChannels counts the device's output channels.
static UInt32 cfOutChannels(AudioObjectID device) {
	AudioObjectPropertyAddress a = cfVolAddress(kAudioDevicePropertyStreamConfiguration, kAudioObjectPropertyElementMain);
	UInt32 size = 0;
	if (AudioObjectGetPropertyDataSize(device, &a, 0, NULL, &size) != noErr || size < sizeof(AudioBufferList)) return 0;
	AudioBufferList* list = malloc(size);
	if (list == NULL) return 0;
	UInt32 channels = 0;
	if (AudioObjectGetPropertyData(device, &a, 0, NULL, &size, list) == noErr) {
		for (UInt32 i = 0; i < list->mNumberBuffers; i++) channels += list->mBuffers[i].mNumberChannels;
	}
	free(list);
	return channels;
}

// cfVolRead reads one volume, 0 to 1. 1 on success.
static int cfVolRead(AudioObjectID device, UInt32 element, Float32* value) {
	AudioObjectPropertyAddress a = cfVolAddress(kAudioDevicePropertyVolumeScalar, element);
	if (!AudioObjectHasProperty(device, &a)) return 0;
	UInt32 size = sizeof *value;
	return AudioObjectGetPropertyData(device, &a, 0, NULL, &size, value) == noErr && size == sizeof *value;
}

static int cfVolSettable(AudioObjectID device, UInt32 element) {
	AudioObjectPropertyAddress a = cfVolAddress(kAudioDevicePropertyVolumeScalar, element);
	Boolean settable = false;
	return AudioObjectHasProperty(device, &a) && AudioObjectIsPropertySettable(device, &a, &settable) == noErr && settable;
}

// cfVolWrite sets one volume. 1 on success.
static int cfVolWrite(AudioObjectID device, UInt32 element, Float32 value) {
	AudioObjectPropertyAddress a = cfVolAddress(kAudioDevicePropertyVolumeScalar, element);
	return AudioObjectSetPropertyData(device, &a, 0, NULL, sizeof value, &value) == noErr;
}
*/
import "C"

import (
	"math"
	"unsafe"
)

// coreAudio is audioHardware on macOS.
type coreAudio struct{}

func (coreAudio) defaultOutput() (string, []uint32, audioOutput, bool) {
	device := C.cfOutDefault()
	if device == 0 {
		return "", nil, nil, false
	}
	cuid := C.cfOutUID(device)
	if cuid == nil {
		return "", nil, nil, false
	}
	defer C.free(unsafe.Pointer(cuid))
	out := coreAudioOutput{device: device}
	elements := volumeElements(uint32(C.cfOutChannels(device)), out.settable, out.readable)
	if elements == nil {
		return "", nil, nil, false
	}
	out.elements = elements
	return C.GoString(cuid), elements, out, true
}

func (coreAudio) output(uid string, elements []uint32) (audioOutput, bool) {
	cuid := C.CString(uid)
	defer C.free(unsafe.Pointer(cuid))
	device := C.cfOutByUID(cuid)
	if device == 0 {
		return nil, false
	}
	return coreAudioOutput{device: device, elements: elements}, true
}

// coreAudioOutput is some of a device's volumes.
type coreAudioOutput struct {
	device   C.AudioObjectID
	elements []uint32
}

func (o coreAudioOutput) settable(element uint32) bool {
	return C.cfVolSettable(o.device, C.UInt32(element)) != 0
}

func (o coreAudioOutput) readable(element uint32) bool {
	_, ok := o.readOne(element)
	return ok
}

func (o coreAudioOutput) readOne(element uint32) (float32, bool) {
	var v C.Float32
	if C.cfVolRead(o.device, C.UInt32(element), &v) == 0 {
		return 0, false
	}
	f := float32(v)
	return f, !math.IsNaN(float64(f)) && f >= 0 && f <= 1
}

func (o coreAudioOutput) read() ([]float32, bool) {
	values := make([]float32, len(o.elements))
	for i, e := range o.elements {
		v, ok := o.readOne(e)
		if !ok {
			return nil, false
		}
		values[i] = v
	}
	return values, true
}

// write tries every element, so a failure on one still moves the rest and rollback has all of
// them to put back.
func (o coreAudioOutput) write(values []float32) bool {
	ok := len(values) == len(o.elements)
	for i, e := range o.elements {
		if i < len(values) && C.cfVolWrite(o.device, C.UInt32(e), C.Float32(values[i])) == 0 {
			ok = false
		}
	}
	return ok
}
