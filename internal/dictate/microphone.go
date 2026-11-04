package dictate

import "slices"

// Transport says how an input connects, as far as choosing one cares. Ported, with the rules
// below, from Hex (audio.rs, audio/transport.rs; MIT, see gui/frontend/public/HEX-LICENSE.md).
type Transport string

const (
	// TransportBuiltIn is the internal microphone, off while a MacBook's lid is closed. A
	// headphone-jack input is TransportOther.
	TransportBuiltIn Transport = "built_in"
	// TransportBluetooth: opening its microphone switches the headset into call audio.
	TransportBluetooth Transport = "bluetooth"
	// TransportUSB is a USB input.
	TransportUSB Transport = "usb"
	// TransportVirtual is a virtual or aggregate device, which may record silence outside
	// its own app.
	TransportVirtual Transport = "virtual"
	// TransportContinuity is an iPhone's microphone: opening it prompts on the phone and can
	// fail.
	TransportContinuity Transport = "continuity"
	// TransportOther is anything else, a jack or Thunderbolt input.
	TransportOther Transport = "other"
)

// Input is a connected input device.
type Input struct {
	UID, Name string
	Transport Transport
}

// InputFacts is what choosing an input reads.
type InputFacts struct {
	Inputs []Input
	// Default is the system default input's UID.
	Default string
	// LidClosed: a MacBook's lid is closed, so its built-in microphone is off though listed.
	LidClosed bool
	// Microphone is dictation.microphone: a device UID, "" for the system default.
	Microphone string
	// AvoidBluetooth is dictation.avoid_bluetooth.
	AvoidBluetooth bool
}

// MicState is what the Microphone row says.
type MicState string

const (
	// MicPlain follows the system default.
	MicPlain MicState = "plain"
	// MicAvoiding listens to another input because the default is Bluetooth.
	MicAvoiding MicState = "avoiding"
	// MicNamed listens to the microphone the setting names.
	MicNamed MicState = "named"
	// MicMissing: the setting names a microphone that cannot be used now.
	MicMissing MicState = "missing"
)

// MicPick is the choice.
type MicPick struct {
	// UID is the device to open; "" leaves the system default, followed as it changes.
	UID   string
	State MicState
	// Name is what is listened to in place of the default, and DefaultName the default's own
	// name, when State is MicAvoiding.
	Name, DefaultName string
}

// PickMicrophone chooses the input a session opens. A microphone the setting names is always
// used, Bluetooth or not, while it can be. Without one, a Bluetooth default gives way to the
// built-in microphone, else the first other real input, when the setting asks. A virtual input
// or an iPhone never stands in, though either is used as the default or by name.
func PickMicrophone(f InputFacts) MicPick {
	state := MicPlain
	off := func(in Input) bool { return f.LidClosed && in.Transport == TransportBuiltIn }
	if f.Microphone != "" {
		if in, ok := findInput(f.Inputs, f.Microphone); ok && !off(in) {
			return MicPick{UID: in.UID, State: MicNamed}
		}
		state = MicMissing
	}
	def, listed := findInput(f.Inputs, f.Default)
	defaultUsable := len(f.Inputs) > 0 && f.Default != "" && !(listed && off(def))
	avoided := func(in Input) bool { return f.AvoidBluetooth && in.Transport == TransportBluetooth }
	defaultAvoided := listed && avoided(def)
	if defaultUsable && !defaultAvoided {
		return MicPick{State: state}
	}
	usable := func(in Input) bool {
		return !off(in) && in.Transport != TransportVirtual && in.Transport != TransportContinuity
	}
	standIn := func(ok func(Input) bool) (Input, bool) {
		i := slices.IndexFunc(f.Inputs, func(in Input) bool { return usable(in) && ok(in) })
		if i < 0 {
			return Input{}, false
		}
		return f.Inputs[i], true
	}
	in, ok := standIn(func(in Input) bool { return in.Transport == TransportBuiltIn })
	if !ok {
		in, ok = standIn(func(in Input) bool { return !avoided(in) })
	}
	if ok {
		pick := MicPick{UID: in.UID, State: state}
		if defaultAvoided && state == MicPlain {
			pick.State, pick.Name, pick.DefaultName = MicAvoiding, in.Name, def.Name
		}
		return pick
	}
	// A Bluetooth default beats recording nothing.
	if defaultUsable {
		return MicPick{State: state}
	}
	if in, ok := standIn(func(Input) bool { return true }); ok {
		return MicPick{UID: in.UID, State: state}
	}
	return MicPick{State: state}
}

func findInput(inputs []Input, uid string) (Input, bool) {
	i := slices.IndexFunc(inputs, func(in Input) bool { return in.UID == uid })
	if i < 0 {
		return Input{}, false
	}
	return inputs[i], true
}
