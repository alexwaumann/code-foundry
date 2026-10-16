package main

import "testing"

func TestButtonCenterY(t *testing.T) {
	tests := []struct {
		zoom int
		want float64
	}{
		{100, 34},
		{90, 30.6},
		{125, 42.5},
		{150, 51},
		{200, 68},
	}
	for _, tt := range tests {
		if got := buttonCenterY(tt.zoom); got < tt.want-1e-9 || got > tt.want+1e-9 {
			t.Errorf("buttonCenterY(%d) = %v, want %v", tt.zoom, got, tt.want)
		}
	}
}
