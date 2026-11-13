"""
Makes the app icons from the icon pack's 512 px picture.

The pack's picture is a circle on an opaque white square. This script makes
all that is outside the circle transparent, then writes:
  public/video-sage-logo.png, src-tauri/icons/icon.png   (512 px)
  public/icon.ico, src-tauri/icons/icon.ico              (16 to 256 px)

Run:  python tools/make-icons.py path/to/play_store_512.png
"""
import sys
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SCALE = 4  # The mask is drawn 4 times larger, then made smaller, for a smooth edge.
INSET = 2.0  # Pixels cut from the circle's edge, to remove the white fringe.

source = Image.open(sys.argv[1]).convert("RGB")
width, height = source.size

# The circle is the box around all pixels that are not near white.
difference = ImageChops.difference(source, Image.new("RGB", source.size, "white")).convert("L")
left, top, right, bottom = difference.point(lambda value: 255 if value > 40 else 0).getbbox()
center_x, center_y = (left + right) / 2, (top + bottom) / 2
radius = min(right - left, bottom - top) / 2 - INSET

mask = Image.new("L", (width * SCALE, height * SCALE), 0)
ImageDraw.Draw(mask).ellipse(
    [(center_x - radius) * SCALE, (center_y - radius) * SCALE, (center_x + radius) * SCALE, (center_y + radius) * SCALE],
    fill=255,
)
mask = mask.resize((width, height), Image.LANCZOS)

icon = source.convert("RGBA")
icon.putalpha(mask)
# Cut to the circle's box and back to full size, so the circle fills the icon.
box = (round(center_x - radius), round(center_y - radius), round(center_x + radius), round(center_y + radius))
icon = icon.crop(box).resize((512, 512), Image.LANCZOS)

for path in ("public/video-sage-logo.png", "src-tauri/icons/icon.png"):
    icon.save(ROOT / path)
for path in ("public/icon.ico", "src-tauri/icons/icon.ico"):
    icon.save(ROOT / path, format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print(f"circle center ({center_x}, {center_y}), radius {radius}")
