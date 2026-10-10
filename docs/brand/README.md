# Brand

The app icon is a painted, Frieren-style scene: a chained crucible on a ruined stone
foundry pouring molten metal into a `{ }` mould, mountains and a dawn sky behind. It was
generated as a 2048x2048 image; the generator prompt and the original live outside the
repo, since macOS never renders an icon above 1024px (512pt @2x).

## macOS icon assets

- `gui/build/appicon.icon/Assets/logo-art.png` is the source of truth: the painting at
  1024x1024, no alpha, full bleed (the earlier version had a painted metal frame; it was
  replaced on 2026-10-10 with a frameless rendering of the same scene). It is the single layer of the
  Icon Composer bundle for macOS 26 (`appicon.icon/icon.json`: scale 1.0, system mask,
  specular on, translucency off). Compiling the bundle to `darwin/Assets.car` needs
  `actool` from a full Xcode install; the stale Wails `Assets.car` was removed so the
  bundle falls back to `icons.icns` until it is regenerated.
- `gui/build/appicon.png` is the same painting masked to a superellipse (n=5, close to
  Apple's squircle) at 824px on a transparent 1024px canvas, the Apple icon grid.
  `wails3 generate icons` turns it into `gui/build/darwin/icons.icns`.

Regenerate everything from the layer PNG, from `gui/build`:

```
python3 - <<'EOF'
from PIL import Image, ImageDraw
import math
src = Image.open('appicon.icon/Assets/logo-art.png').convert('RGBA')
CANVAS, ICON = 1024, 824
art = src.resize((ICON, ICON), Image.LANCZOS)
S = 4; r = ICON*S/2; n = 5
m = Image.new('L', (ICON*S, ICON*S), 0)
pts = []
for i in range(1440):
    t = 2*math.pi*i/1440; c, s = math.cos(t), math.sin(t)
    pts.append((math.copysign(abs(c)**(2/n), c)*r+r, math.copysign(abs(s)**(2/n), s)*r+r))
ImageDraw.Draw(m).polygon(pts, fill=255)
art.putalpha(m.resize((ICON, ICON), Image.LANCZOS))
out = Image.new('RGBA', (CANVAS, CANVAS), (0, 0, 0, 0))
out.paste(art, ((CANVAS-ICON)//2,)*2, art)
out.save('appicon.png')
EOF
wails3 generate icons -input appicon.png -windowsfilename "" -macfilename darwin/icons.icns -iconcomposerinput appicon.icon -macassetdir darwin
sips -Z 512 appicon.png --out dockicon.png
```

`gui/build/dockicon.png` is `appicon.png` at 512px. The GUI ships as a bare executable
with no bundle for `icons.icns`, so it embeds this PNG and sets it as the Dock icon at
startup (`gui/icon.go`).
