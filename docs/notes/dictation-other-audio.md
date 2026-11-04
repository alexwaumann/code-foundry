# Dictation: Other audio (2026-11-04)

PR 2 of three, on `dictation-spoken-text.md`'s. `dictation.other_audio` is `do_nothing` (the
default) or `lower`: music and video drop to 20% of their level while the hold key is down.
There is no Pause. Hex's needs per-app control this does not have.

## What shipped

* `gui/duck.go`: the ramp (Hex's `output_ducking.rs`), the recovery decision, the markers and
  the `ducker`, all pure Go behind `audioHardware`. `gui/duck_darwin.go`: CoreAudio (Hex's
  `recording_environment/ducking.rs`).
* `gui/hold.go`: `holdOS.lowerAudio`, one call in `runHold` and a `released` channel in `finish`.
* `other_audio` on the snapshot, as `hold_key` is. `Paths.LoweredAudio`: `audio-lowered/`.

## Decisions

* **When.** A hold that has somewhere to go arms the ducker, which waits `altHoldMin` (300 ms)
  on its own timer; a release first means nothing was touched, so Option+Left never dips.
  It covers composer holds too, as `runHold` is shared. The mic button does not lower: it has no
  release, and the brief says holds.
* **One goroutine.** The ducker's loop owns the ramp, so a release racing the 300 ms cannot leave
  it lowered: there is no check-then-act across threads. `lowerAudio` only posts to a buffered
  channel, so a stuck CoreAudio call can never hold up a press.
* **The ramp is Hex's**: 16 ms ticks, a 1 s smoothstep, each channel scaled by the same factor so
  the balance stays, and a 1.5 s bound for Bluetooth to report back. A settled volume that moved
  was moved by hand and stands. A failed write rolls every channel back. A hold during the
  ramp back turns it around, keeping the first volume.
* **Channels, else master.** Master only when no channel volume can be read, as a master write
  would flatten a balance that cannot be put back (`volumeElements`).

### It must never stay low

Four ways out, from the likely to the unlikely:

1. **Release.** `finish` closes `released`, and every way a hold ends goes through `finish`,
   a stopping tap included (`interrupt`).
2. **No release.** A lost release heals only at the next modifier, so `duckLongest` (10 minutes)
   restores anyway.
3. **Quit.** `app.OnShutdown` calls `ducker.close`: one write, no ramp, up to 500 ms. That covers
   ⌘Q, Quit from the menu bar, `app.relaunch`, `app.restart`, and SIGTERM and SIGINT, which Wails
   turns into `Quit`.
4. **Crash or kill.** A marker is on disk from before the first write until the volume is
   back: UID, elements, original, lowered, settled. No marker can be written, nothing is lowered.

`decideRecovery` reads a marker left behind:

| Device | Volume now | Marker | Then |
| --- | --- | --- | --- |
| not connected | | any | keep it, look again |
| here | at the original | any | forget it |
| here | exactly the lowered value | settled | put it back |
| here | anything else | settled | forget it: moved by hand |
| here | one point between the two, channels in step | unsettled | put it back |
| here | between the two | partial | put it back |
| here | anything else | unsettled, partial | forget it: moved by hand |

* **Settled matters.** On a settled marker any other value was a hand, so a volume turned up a
  little after a crash is left alone. Only during a ramp, about a second, can a hand be
  mistaken for the ramp. The marker goes unsettled before the first write of the way back, or a
  crash there would read as a hand and leave the volume low.
* **The lowered value is what the hardware reported,** not 0.2 times the original: devices
  quantise.
* **Partial** is a write back that failed, which can leave channels out of step. Without it,
  a second try would read that as a hand and give up.
* **One marker per device**, so AirPods left low and away do not stop the speakers being lowered.
  A hold checks them first as well as the launch, so a device back since then is put right
  before its volume is read as the new original.
* **Recovery runs after `application.New`,** where a second launch has already ended, so no other
  process of this home can be mid-hold. It runs whatever the setting says now.
* A marker that cannot be parsed is dropped: `writeFileAtomic` means it is not one of ours.

## Gotchas

* Two homes (a dev GUI beside the real one) on one output can stack: the second reads the first's
  lowered volume as its original. The first then sees a moved volume and leaves it, and the
  second restores to the lowered level. Markers are per home.
* A crash with the app never relaunched stays low. The daemon could take this on; not done.
* Volume on HDMI and some USB devices cannot be set: nothing happens, with a debug line.
* While the audio is lowered, the alert sounds and the stop tone are lowered too, if they are on
  the same output. The stop tone plays during the ramp back.

## Verification

`/tmp/cf-check.sh`. Table tests in `duck_test.go`: the ramp (Hex's three, plus a slow device),
`TestVolumeElements`, `TestDecideRecovery`, quitting and crashing at each point of a hold,
an absent device, a device lost mid-hold, a failed recovery write, no marker, and the loop on
the real clock. `TestHoldLowersAudio` for the hold's side. No cgo in tests.
