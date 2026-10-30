package main

import (
	"context"
	"encoding/binary"
	"io"
	"math"
)

// The microphone's output, as DictationService.Audio takes it: 16 kHz mono signed
// 16-bit little-endian samples, in frames of micFrameBytes (20 ms).
const (
	micSampleRate = 16000
	micFrameBytes = micSampleRate / 50 * 2
	// micFrameBuffer is how many frames wait for the daemon (2 s) before new ones are
	// dropped: the pipe from the audio thread must never stop being read.
	micFrameBuffer = 100
)

// micPermission is macOS's microphone permission for this app (AVAuthorizationStatus).
type micPermission int

const (
	micUndetermined micPermission = iota // never asked: the first request shows the prompt
	micDenied                            // denied by the user, or restricted by a profile
	micGranted
)

func (p micPermission) String() string {
	switch p {
	case micDenied:
		return "denied"
	case micGranted:
		return "granted"
	}
	return "undetermined"
}

// micFrame is one 20 ms frame and its level.
type micFrame struct {
	pcm []byte
	rms float32
}

// microphone opens the Mac's microphone (avMicrophone in mic_darwin.go; a fake in tests).
type microphone interface {
	// Permission is the permission now. It never prompts.
	Permission() micPermission
	// RequestAccess asks macOS for the microphone, which prompts when the permission is
	// undetermined, and reports whether it was granted. It returns early with ctx.
	RequestAccess(ctx context.Context) (granted bool, err error)
	// Start opens the microphone.
	Start() (micCapture, error)
}

// micCapture is an open microphone.
type micCapture interface {
	// Frames delivers the audio; it is closed once Stop has run (or capture failed).
	Frames() <-chan micFrame
	// Stop closes the microphone. Safe to call more than once.
	Stop()
}

// frameChunker cuts a byte stream of samples into micFrameBytes frames.
type frameChunker struct {
	buf []byte
}

// push appends p and returns every whole frame now buffered, each in its own slice.
func (c *frameChunker) push(p []byte) [][]byte {
	c.buf = append(c.buf, p...)
	var out [][]byte
	for len(c.buf) >= micFrameBytes {
		f := make([]byte, micFrameBytes)
		copy(f, c.buf)
		out = append(out, f)
		c.buf = c.buf[micFrameBytes:]
	}
	// Keep the remainder at the front so the buffer does not creep along its array.
	c.buf = append(c.buf[:0:0], c.buf...)
	return out
}

// pcmRMS is the root mean square of 16-bit little-endian samples, 0 (silence) to 1
// (full scale). A trailing odd byte is ignored.
func pcmRMS(pcm []byte) float32 {
	n := len(pcm) / 2
	if n == 0 {
		return 0
	}
	var sum float64
	for i := range n {
		s := float64(int16(binary.LittleEndian.Uint16(pcm[2*i:])))
		sum += s * s
	}
	return float32(min(math.Sqrt(sum/float64(n))/32768, 1))
}

// pumpFrames reads samples from r until it ends, sending them on out as frames with
// their levels, and closes out. A frame that does not fit in out is dropped: the
// writer on the other side of r is the audio thread, which must not wait on the
// daemon.
func pumpFrames(r io.Reader, out chan<- micFrame) {
	defer close(out)
	var c frameChunker
	buf := make([]byte, 4096)
	for {
		n, err := r.Read(buf)
		for _, f := range c.push(buf[:n]) {
			select {
			case out <- micFrame{pcm: f, rms: pcmRMS(f)}:
			default:
			}
		}
		if err != nil {
			return
		}
	}
}
