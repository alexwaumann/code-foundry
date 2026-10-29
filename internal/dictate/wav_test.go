package dictate

import (
	"encoding/binary"
	"strings"
	"testing"
)

// wavFile builds a WAV: a fmt chunk with the given fields, optional chunks before data
// (an odd-sized one exercises the padding), then data.
func wavFile(format, channels uint16, rate uint32, bits uint16, extra []byte, pcm []byte) []byte {
	le := binary.LittleEndian
	var b []byte
	chunk := func(id string, body []byte) {
		b = append(b, id...)
		b = le.AppendUint32(b, uint32(len(body)))
		b = append(b, body...)
		if len(body)%2 == 1 {
			b = append(b, 0)
		}
	}
	f := le.AppendUint16(nil, format)
	f = le.AppendUint16(f, channels)
	f = le.AppendUint32(f, rate)
	f = le.AppendUint32(f, rate*uint32(channels)*uint32(bits)/8)
	f = le.AppendUint16(f, channels*bits/8)
	f = le.AppendUint16(f, bits)
	chunk("fmt ", f)
	if extra != nil {
		chunk("FLLR", extra)
	}
	chunk("data", pcm)
	return append(append([]byte("RIFF"), le.AppendUint32(nil, uint32(4+len(b)))...), append([]byte("WAVE"), b...)...)
}

func TestReadWAV(t *testing.T) {
	pcm := []byte{0x00, 0x40, 0x00, 0xc0}
	tests := []struct {
		name    string
		file    []byte
		want    int
		wantErr string
	}{
		{"plain", wavFile(1, 1, 16000, 16, nil, pcm), 2, ""},
		{"filler chunk (afconvert)", wavFile(1, 1, 16000, 16, []byte{1, 2, 3}, pcm), 2, ""},
		{"stereo", wavFile(1, 2, 16000, 16, nil, pcm), 0, "want 16-bit PCM, mono"},
		{"44.1 kHz", wavFile(1, 1, 44100, 16, nil, pcm), 0, "44100 Hz"},
		{"float", wavFile(3, 1, 16000, 32, nil, pcm), 0, "format 3"},
		{"not a wav", []byte("hello world, not RIFF"), 0, "not a RIFF/WAVE file"},
		{"truncated data", wavFile(1, 1, 16000, 16, nil, pcm)[:46], 1, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ReadWAV(tt.file)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if len(got) != tt.want || got[0] != 0.5 {
				t.Fatalf("got %v", got)
			}
		})
	}
}
