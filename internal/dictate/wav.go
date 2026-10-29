package dictate

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// ReadWAV returns the samples of a 16 kHz mono 16-bit PCM WAV file (what
// `afconvert -f WAVE -d LEI16@16000 -c 1` writes), as floats.
func ReadWAV(b []byte) ([]float32, error) {
	if len(b) < 12 || string(b[0:4]) != "RIFF" || string(b[8:12]) != "WAVE" {
		return nil, errors.New("wav: not a RIFF/WAVE file")
	}
	var fmtSeen bool
	for p := 12; p+8 <= len(b); {
		id := string(b[p : p+4])
		size := int(binary.LittleEndian.Uint32(b[p+4 : p+8]))
		body := p + 8
		if size < 0 || body+size > len(b) {
			if id == "data" { // a truncated or streamed file: take what is there
				size = len(b) - body
			} else {
				return nil, fmt.Errorf("wav: chunk %q runs past the end", id)
			}
		}
		switch id {
		case "fmt ":
			if size < 16 {
				return nil, errors.New("wav: short fmt chunk")
			}
			f := b[body : body+size]
			format := binary.LittleEndian.Uint16(f[0:2])
			channels := binary.LittleEndian.Uint16(f[2:4])
			rate := binary.LittleEndian.Uint32(f[4:8])
			bits := binary.LittleEndian.Uint16(f[14:16])
			if format == 0xFFFE && size >= 26 { // WAVE_FORMAT_EXTENSIBLE: the sub-format
				format = binary.LittleEndian.Uint16(f[24:26])
			}
			if format != 1 || channels != 1 || rate != SampleRate || bits != 16 {
				return nil, fmt.Errorf("wav: want 16-bit PCM, mono, %d Hz (got format %d, %d channels, %d Hz, %d bits)", SampleRate, format, channels, rate, bits)
			}
			fmtSeen = true
		case "data":
			if !fmtSeen {
				return nil, errors.New("wav: data before fmt")
			}
			return DecodePCM(b[body : body+size&^1])
		}
		p = body + size + size&1 // chunks are word aligned
	}
	return nil, errors.New("wav: no data chunk")
}
