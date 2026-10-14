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

def bell(b, start, f, amp, decay):
    for r, a, d in [(1, 1, 1), (2.0, .35, .6), (2.76, .25, .45), (5.40, .10, .25), (8.93, .04, .15)]:
        add_partial(b, start, f * r, amp * a, decay * d)

def note(n): return 440 * 2 ** ((n - 69) / 12)

def chime():
    b = buf(1.1); bell(b, 0, note(84 - 12), .5, .9); bell(b, .11, note(91 - 12), .5, 1.0); return b

def glass():
    b = buf(1.3)
    for r, a, d in [(1, 1, 1.2), (2.32, .45, .7), (4.25, .2, .45), (6.63, .08, .3)]:
        add_partial(b, 0, note(93) * r, a, d, attack=0.001, vib=0.0008)
    add_noise(b, 0, .08, .015, lp=.9)
    return b

def marimba():
    b = buf(0.9)
    for i, n in enumerate([72, 76, 79]):
        f = note(n); t = i * .075
        add_partial(b, t, f, .6, .45)
        add_partial(b, t, f * 3.93, .18, .08)
        add_partial(b, t, f * 9.2, .05, .03)
        add_noise(b, t, .05, .01, lp=.5)
    return b

def wood():
    b = buf(0.6)
    for t, f in [(0, 520), (.12, 640)]:
        add_partial(b, t, f, .7, .09, attack=.0008)
        add_partial(b, t, f * 2.6, .2, .04, attack=.0008)
        add_partial(b, t, f * .5, .25, .12, attack=.0015)
        add_noise(b, t, .25, .012, lp=.25)
    return b

def forge():
    b = buf(1.4)
    f = 1180
    for r, a, d in [(1, 1, .9), (2.76, .5, .7), (5.40, .3, .5), (8.93, .15, .35), (13.3, .06, .2)]:
        add_partial(b, 0, f * r, a * .6, d, attack=.0006)
    add_noise(b, 0, .35, .02, lp=.8)
    for r in [3.01, 3.02, 4.49]:   # detuned shimmer, slow bloom
        add_partial(b, 0.02, f * r, .05, 1.2, attack=.08, vib=.002)
    return b

def bloom():
    b = buf(1.1)
    add_fm(b, 0, note(76), .55, .9, 1.0, 1.6, .25)
    add_fm(b, .13, note(83), .55, 1.0, 1.0, 1.6, .25)
    add_partial(b, 0, note(76) * 14, .03, .05); add_partial(b, .13, note(83) * 14, .03, .05)
    return b

SOUNDS = [
    ("chime", "Chime", "Soft rising bell fifth, C6 then G6.", chime),
    ("glass", "Glass", "Single glassy ting with a long, slightly wobbly tail.", glass),
    ("marimba", "Marimba", "Warm three-note C major arpeggio.", marimba),
    ("wood", "Wood", "Low wooden double tap, second tap a touch higher.", wood),
    ("forge", "Forge", "Anvil tap with a slow metallic shimmer. On brand.", forge),
    ("bloom", "Bloom", "FM electric-piano two-note rise, E5 then B5.", bloom),
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
