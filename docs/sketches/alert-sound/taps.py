"""Dictation start and stop taps: one Soft mallet knock each (stdlib only)."""
import math, random, struct, sys, wave
SR = 48000; OUT = sys.argv[1]; random.seed(7)
def add_partial(b, f, amp, decay, attack):
    k = math.log(1000) / decay
    for i in range(len(b)):
        t = i / SR
        b[i] += amp * (t / attack if t < attack else 1.0) * math.exp(-k * t) * math.sin(2 * math.pi * f * t)
def add_noise(b, amp, decay, lp=.25):
    k = math.log(1000) / decay; y = 0.0
    for i in range(len(b)):
        y += lp * (random.uniform(-1, 1) - y); b[i] += amp * math.exp(-k * i / SR) * y
def tap(f):
    b = [0.0] * int(SR * .14)
    for r, a, d in ((1, .7, .09), (2.6, .2, .04), (.5, .25, .12)):
        add_partial(b, f * r, a, d, .004)
    add_noise(b, .06, .012)
    fade = int(.03 * SR)
    for i in range(fade): b[-1 - i] *= i / fade
    return b
for name, f in (("start", 640), ("stop", 520)):
    b = tap(f); w = int(.1 * SR)
    rms = math.sqrt(sum(x * x for x in b[:w]) / w); g = 10 ** (-18 / 20) / rms
    peak = max(abs(x) for x in b) * g
    if peak > .89: g *= .89 / peak
    with wave.open(f"{OUT}/{name}.wav", "wb") as o:
        o.setnchannels(1); o.setsampwidth(2); o.setframerate(SR)
        o.writeframes(b"".join(struct.pack("<h", int(max(-1, min(1, x * g)) * 32767)) for x in b))
    print(name, f, round(len(b) / SR * 1000), "ms")
