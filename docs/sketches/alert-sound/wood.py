"""Generates alert sound candidates as 48 kHz mono 16-bit WAVs (stdlib only)."""
import math, random, struct, sys, wave, json

SR = 48000
OUT = sys.argv[1]
random.seed(7)

def buf(sec): return [0.0] * int(SR * sec)

def add_partial(b, start, freq, amp, decay, attack=0.002, phase=0.0, vib=0.0):
    """Sine partial with linear attack and exponential decay (decay = seconds to -60 dB)."""
    if freq > 18000: return
    s0 = int(start * SR)
    k = math.log(1000) / decay
    for i in range(s0, len(b)):
        t = (i - s0) / SR
        env = (t / attack if t < attack else 1.0) * math.exp(-k * t)
        if env < 1e-5 and t > attack: break
        f = freq * (1 + vib * math.sin(2 * math.pi * 5.5 * t))
        b[i] += amp * env * math.sin(2 * math.pi * f * t + phase)

def add_noise(b, start, amp, decay, lp=0.3, hp=0.0):
    s0 = int(start * SR); k = math.log(1000) / decay; y = 0.0; x1 = 0.0; h = 0.0
    for i in range(s0, len(b)):
        t = (i - s0) / SR; env = math.exp(-k * t)
        if env < 1e-5: break
        x = random.uniform(-1, 1)
        y += lp * (x - y)                 # one-pole low-pass
        h = hp * (h + y - x1) if hp else y  # optional one-pole high-pass
        x1 = y
        b[i] += amp * env * h

def add_fm(b, start, freq, amp, decay, ratio, index, idecay):
    s0 = int(start * SR); k = math.log(1000) / decay; ki = math.log(1000) / idecay
    for i in range(s0, len(b)):
        t = (i - s0) / SR
        env = min(1, t / 0.003) * math.exp(-k * t)
        if env < 1e-5 and t > 0.003: break
        mod = index * math.exp(-ki * t) * math.sin(2 * math.pi * freq * ratio * t)
        b[i] += amp * env * math.sin(2 * math.pi * freq * t + mod)


def knock(b, t, f, amp=1.0, ring=1.0, click=.25, attack=.0008, modes=((1, .7, .09), (2.6, .2, .04), (.5, .25, .12))):
    for r, a, d in modes:
        add_partial(b, t, f * r, a * amp, d * ring, attack=attack if r >= 1 else max(attack, .0015))
    if click: add_noise(b, t, click * amp, .012, lp=.25)

def st(f, n): return f * 2 ** (n / 12)

def original():
    b = buf(.6); knock(b, 0, 520); knock(b, .12, 640); return b

def down3():
    b = buf(.6); knock(b, 0, st(520, -3)); knock(b, .12, st(640, -3)); return b

def down5():
    b = buf(.65); knock(b, 0, st(520, -5), ring=1.1); knock(b, .12, st(640, -5), ring=1.1); return b

def single():
    b = buf(.45); knock(b, 0, 560, ring=1.2); return b

def falling():
    b = buf(.6); knock(b, 0, 640); knock(b, .12, 520); return b

def triple():
    b = buf(.7); knock(b, 0, 520, amp=.9); knock(b, .1, 520, amp=.8); knock(b, .2, 640); return b

HOLLOW = ((1, .8, .22), (3.1, .12, .06), (.5, .18, .16))
def hollow():
    b = buf(.8); knock(b, 0, 470, modes=HOLLOW, click=.18); knock(b, .13, 580, modes=HOLLOW, click=.18); return b

def soft():
    b = buf(.6); knock(b, 0, 520, click=.06, attack=.004); knock(b, .12, 640, click=.06, attack=.004); return b

def ring():
    b = buf(1.2); knock(b, 0, 520); knock(b, .12, 640)
    for r, a, d in [(1, .12, .9), (2.76, .05, .6), (5.4, .02, .4)]:
        add_partial(b, .12, 640 * 1.5 * r, a, d, attack=.003)
    return b

SOUNDS = [
    ("wood", "Wood (original)", "The one you liked: low double tap, second tap a touch higher.", original),
    ("down3", "Wood −3", "Same, three semitones lower, same length.", down3),
    ("down5", "Wood −5", "Five semitones lower, a slightly longer ring.", down5),
    ("single", "Single knock", "Just one tap, a little more ring.", single),
    ("falling", "Falling", "Higher tap first, then lower: settles rather than asks.", falling),
    ("triple", "Knock knock knock", "Two taps on the same note, then the higher one.", triple),
    ("hollow", "Hollow block", "Temple-block resonance: rounder and longer, less click.", hollow),
    ("soft", "Soft mallet", "Felt mallet: almost no click, rounded attack.", soft),
    ("ring", "Wood + ring", "The double tap with a faint metallic ring after it, a nod to the anvil.", ring),
]
TARGET_RMS = 10 ** (-18 / 20)  # over the loudest 150 ms window
meta = []
for key, name, desc, fn in SOUNDS:
    b = fn()
    fade = int(.03 * SR)
    for i in range(fade): b[-1 - i] *= i / fade
    w = int(.15 * SR); best = 0.0; acc = sum(x * x for x in b[:w])
    for i in range(w, len(b), 240):
        acc = sum(x * x for x in b[i - w:i]); best = max(best, acc)
    rms = math.sqrt(best / w)
    g = TARGET_RMS / rms
    peak = max(abs(x) for x in b) * g
    if peak > .89: g *= .89 / peak  # keep 1 dB headroom
    with wave.open(f"{OUT}/{key}.wav", "wb") as f:
        f.setnchannels(1); f.setsampwidth(2); f.setframerate(SR)
        f.writeframes(b"".join(struct.pack("<h", int(max(-1, min(1, x * g)) * 32767)) for x in b))
    meta.append({"key": key, "name": name, "desc": desc, "ms": round(len(b) / SR * 1000), "peak_db": round(20 * math.log10(peak if peak <= .89 else .89), 1)})
print(json.dumps(meta, indent=1))
