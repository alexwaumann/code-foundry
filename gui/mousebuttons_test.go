package main

import "testing"

func TestMouseButtonCommand(t *testing.T) {
	tests := []struct {
		name   string
		button int
		want   string
		wantOK bool
	}{
		{"left", 0, "", false},
		{"right", 1, "", false},
		{"middle", 2, "", false},
		{"button 4 (rear side) goes back", 3, "view.back", true},
		{"button 5 (front side) goes forward", 4, "view.forward", true},
		{"button 6", 5, "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := mouseButtonCommand(tt.button)
			if got != tt.want || ok != tt.wantOK {
				t.Errorf("mouseButtonCommand(%d) = %q, %v; want %q, %v", tt.button, got, ok, tt.want, tt.wantOK)
			}
		})
	}
}
