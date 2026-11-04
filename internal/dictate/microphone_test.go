package dictate

import "testing"

func TestPickMicrophone(t *testing.T) {
	mac := Input{"mac", "MacBook Pro Microphone", TransportBuiltIn}
	pods := Input{"pods", "AirPods Pro", TransportBluetooth}
	beats := Input{"beats", "Beats", TransportBluetooth}
	shure := Input{"shure", "Shure MV7", TransportUSB}
	jack := Input{"jack", "External Microphone", TransportOther}
	zoom := Input{"zoom", "ZoomAudioDevice", TransportVirtual}
	phone := Input{"phone", "iPhone Microphone", TransportContinuity}

	tests := []struct {
		name string
		f    InputFacts
		want MicPick
	}{
		{"the default, a wired one", InputFacts{Inputs: []Input{mac, shure}, Default: "shure", AvoidBluetooth: true}, MicPick{State: MicPlain}},
		{"a Bluetooth default, avoid off", InputFacts{Inputs: []Input{mac, pods}, Default: "pods"}, MicPick{State: MicPlain}},
		{"a Bluetooth default gives way to the built-in mic", InputFacts{Inputs: []Input{shure, pods, mac}, Default: "pods", AvoidBluetooth: true},
			MicPick{UID: "mac", State: MicAvoiding, Name: mac.Name, DefaultName: pods.Name}},
		{"no built-in mic: the first wired or USB input", InputFacts{Inputs: []Input{pods, shure, jack}, Default: "pods", AvoidBluetooth: true},
			MicPick{UID: "shure", State: MicAvoiding, Name: shure.Name, DefaultName: pods.Name}},
		{"no other input: the Bluetooth default", InputFacts{Inputs: []Input{pods}, Default: "pods", AvoidBluetooth: true}, MicPick{State: MicPlain}},
		{"another Bluetooth input does not stand in", InputFacts{Inputs: []Input{pods, beats}, Default: "pods", AvoidBluetooth: true}, MicPick{State: MicPlain}},
		{"a virtual input does not stand in", InputFacts{Inputs: []Input{pods, zoom}, Default: "pods", AvoidBluetooth: true}, MicPick{State: MicPlain}},
		{"an iPhone does not stand in", InputFacts{Inputs: []Input{pods, phone}, Default: "pods", AvoidBluetooth: true}, MicPick{State: MicPlain}},
		{"lid closed, only Bluetooth: the Bluetooth default", InputFacts{Inputs: []Input{mac, pods}, Default: "pods", LidClosed: true, AvoidBluetooth: true}, MicPick{State: MicPlain}},
		{"lid closed, a USB mic stands in", InputFacts{Inputs: []Input{mac, pods, shure}, Default: "pods", LidClosed: true, AvoidBluetooth: true},
			MicPick{UID: "shure", State: MicAvoiding, Name: shure.Name, DefaultName: pods.Name}},
		{"lid closed, the built-in default gives way", InputFacts{Inputs: []Input{mac, shure}, Default: "mac", LidClosed: true}, MicPick{UID: "shure", State: MicPlain}},
		{"lid closed, built-in default, Bluetooth is all there is", InputFacts{Inputs: []Input{mac, pods}, Default: "mac", LidClosed: true, AvoidBluetooth: true}, MicPick{UID: "pods", State: MicPlain}},
		{"a virtual default is used", InputFacts{Inputs: []Input{mac, zoom}, Default: "zoom", AvoidBluetooth: true}, MicPick{State: MicPlain}},
		{"a default that is not listed", InputFacts{Inputs: []Input{mac}, Default: "hidden"}, MicPick{State: MicPlain}},
		{"no inputs", InputFacts{Default: "gone", AvoidBluetooth: true}, MicPick{State: MicPlain}},

		{"a named mic", InputFacts{Inputs: []Input{mac, shure}, Default: "mac", Microphone: "shure"}, MicPick{UID: "shure", State: MicNamed}},
		{"a named Bluetooth mic, avoid on", InputFacts{Inputs: []Input{mac, pods}, Default: "mac", Microphone: "pods", AvoidBluetooth: true}, MicPick{UID: "pods", State: MicNamed}},
		{"a named Bluetooth mic that is the default, avoid on", InputFacts{Inputs: []Input{mac, pods}, Default: "pods", Microphone: "pods", AvoidBluetooth: true}, MicPick{UID: "pods", State: MicNamed}},
		{"a named virtual input", InputFacts{Inputs: []Input{mac, zoom}, Default: "mac", Microphone: "zoom"}, MicPick{UID: "zoom", State: MicNamed}},
		{"a named mic that is missing: the system default", InputFacts{Inputs: []Input{mac}, Default: "mac", Microphone: "shure"}, MicPick{State: MicMissing}},
		{"missing, and the default is Bluetooth", InputFacts{Inputs: []Input{mac, pods}, Default: "pods", Microphone: "shure", AvoidBluetooth: true}, MicPick{UID: "mac", State: MicMissing}},
		{"a named built-in mic with the lid closed", InputFacts{Inputs: []Input{mac, shure}, Default: "shure", Microphone: "mac", LidClosed: true}, MicPick{State: MicMissing}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := PickMicrophone(tt.f); got != tt.want {
				t.Errorf("got %+v, want %+v", got, tt.want)
			}
		})
	}
}
