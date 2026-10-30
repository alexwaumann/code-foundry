package main

import (
	"bytes"
	"encoding/binary"
	"io"
	"math"
	"strings"
	"testing"
)

// samples encodes 16-bit samples little-endian.
func samples(v ...int16) []byte {
	b := make([]byte, 2*len(v))
	for i, s := range v {
		binary.LittleEndian.PutUint16(b[2*i:], uint16(s))
	}
	return b
}

// constant is n samples of v.
func constant(n int, v int16) []byte {
	s := make([]int16, n)
	for i := range s {
		s[i] = v
	}
	return samples(s...)
}

func TestPCMRMS(t *testing.T) {
	tests := []struct {
		name string
		pcm  []byte
		want float64
	}{
		{"empty", nil, 0},
		{"one byte", []byte{0x7f}, 0},
		{"silence", constant(320, 0), 0},
		{"full scale negative", constant(320, math.MinInt16), 1},
		{"full scale positive", constant(320, math.MaxInt16), 32767.0 / 32768},
		{"half scale square wave", samples(16384, -16384, 16384, -16384), 0.5},
		{"odd trailing byte ignored", append(samples(16384, -16384), 0xff), 0.5},
		{"3-4-5", samples(3*4096, 4*4096), math.Sqrt((9.0+16)/2) * 4096 / 32768},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := pcmRMS(tt.pcm); math.Abs(float64(got)-tt.want) > 1e-6 {
				t.Errorf("pcmRMS = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestFrameChunker(t *testing.T) {
	tests := []struct {
		name   string
		pushes []int // byte counts pushed in turn
		frames []int // whole frames returned by each push
		rest   int   // bytes left buffered
	}{
		{"nothing", []int{0}, []int{0}, 0},
		{"short", []int{100}, []int{0}, 100},
		{"exactly one", []int{micFrameBytes}, []int{1}, 0},
		{"one and a bit", []int{micFrameBytes + 2}, []int{1}, 2},
		{"tap buffer of 100 ms", []int{3200}, []int{5}, 0},
		{"odd split across pushes", []int{micFrameBytes - 1, 1, micFrameBytes*2 + 5}, []int{0, 1, 2}, 5},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var c frameChunker
			var in, out []byte
			for i, n := range tt.pushes {
				p := make([]byte, n)
				for j := range p {
					p[j] = byte(len(in) + j)
				}
				in = append(in, p...)
				got := c.push(p)
				if len(got) != tt.frames[i] {
					t.Fatalf("push %d gave %d frames, want %d", i, len(got), tt.frames[i])
				}
				for _, f := range got {
					if len(f) != micFrameBytes {
						t.Fatalf("frame of %d bytes", len(f))
					}
					out = append(out, f...)
				}
			}
			if len(c.buf) != tt.rest {
				t.Errorf("%d bytes buffered, want %d", len(c.buf), tt.rest)
			}
			// Frames come out in order, unchanged.
			if !bytes.Equal(out, in[:len(out)]) || !bytes.Equal(c.buf, in[len(out):]) {
				t.Error("bytes reordered")
			}
		})
	}
}

// chunkReader returns its chunks one Read at a time.
type chunkReader struct{ chunks [][]byte }

func (r *chunkReader) Read(p []byte) (int, error) {
	if len(r.chunks) == 0 {
		return 0, io.EOF
	}
	n := copy(p, r.chunks[0])
	r.chunks = r.chunks[1:]
	return n, nil
}

func TestPumpFrames(t *testing.T) {
	loud := constant(micSampleRate/50, 16384)
	tests := []struct {
		name   string
		chunks [][]byte
		buffer int
		want   []float32 // rms of each frame delivered
	}{
		{"frames with levels", [][]byte{loud, constant(micSampleRate/50, 0)}, 4, []float32{0.5, 0}},
		{"split chunks join", [][]byte{loud[:101], loud[101:]}, 4, []float32{0.5}},
		{"partial frame at the end dropped", [][]byte{loud, loud[:10]}, 4, []float32{0.5}},
		{"full channel drops new frames", [][]byte{loud, loud, loud}, 2, []float32{0.5, 0.5}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			out := make(chan micFrame, tt.buffer)
			pumpFrames(&chunkReader{chunks: tt.chunks}, out)
			var got []float32
			for f := range out { // closed by pumpFrames
				got = append(got, f.rms)
			}
			if len(got) != len(tt.want) {
				t.Fatalf("levels = %v, want %v", got, tt.want)
			}
			for i := range got {
				if math.Abs(float64(got[i]-tt.want[i])) > 1e-6 {
					t.Fatalf("levels = %v, want %v", got, tt.want)
				}
			}
		})
	}
}

func TestPumpSignals(t *testing.T) {
	for _, tc := range []struct {
		name  string
		input string
		want  int // signals pending afterwards (the channel holds one)
	}{
		{"nothing", "", 0},
		{"one change", "c", 1},
		{"a burst coalesces", "ccccc", 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out := make(chan struct{}, 1)
			pumpSignals(strings.NewReader(tc.input), out)
			if got := len(out); got != tc.want {
				t.Errorf("pending = %d, want %d", got, tc.want)
			}
		})
	}
}
