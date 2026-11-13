"""
Makes the app icons from the icon pack's 512 px picture.

The pack's picture has no real transparency: its background is an opaque
white and light grey checkerboard, drawn into the picture. This script makes
that background transparent, then writes:
  public/video-sage-logo.png, src-tauri/icons/icon.png   (512 px)
  public/icon.ico, src-tauri/icons/icon.ico              (16 to 256 px)

The background is all that is light and grey (no colour) and joined to the
border of the picture. Light parts inside the drawing, such as the film
reel, are not joined to the border, so they stay.

Run:  python tools/make-icons.py path/to/play_store_512.png
"""
import sys
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
LIGHT = 110  # A background pixel has all three colour values at this or more.
GREY = 12  # A background pixel has no more than this between its colour values.
MARGIN = 0.03  # The empty part at each side of the icon, as a part of its width.

source = Image.open(sys.argv[1]).convert("RGB")
width, height = source.size
red, green, blue = source.split()
lowest = ImageChops.darker(ImageChops.darker(red, green), blue)
highest = ImageChops.lighter(ImageChops.lighter(red, green), blue)
light = lowest.point(lambda value: 255 if value >= LIGHT else 0)
grey = ImageChops.subtract(highest, lowest).point(lambda value: 255 if value <= GREY else 0)
# White (255) where a pixel can be background.
candidate = ImageChops.multiply(light, grey)

# Fill from each border pixel: the value 128 marks the background.
pixels = candidate.load()
border = [(x, y) for x in range(width) for y in (0, height - 1)] + [(x, y) for y in range(height) for x in (0, width - 1)]
for point in border:
    if pixels[point] == 255:
        ImageDraw.floodfill(candidate, point, 128)
alpha = candidate.point(lambda value: 0 if value == 128 else 255)
# One pixel comes off the edge, where the drawing is mixed with the background, and the edge is made soft.
alpha = alpha.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.7))

icon = source.convert("RGBA")
icon.putalpha(alpha)
# The drawing goes to the center of a square, with a small margin.
left, top, right, bottom = alpha.point(lambda value: 255 if value > 8 else 0).getbbox()
drawing = icon.crop((left, top, right, bottom))
side = round(max(drawing.size) / (1 - 2 * MARGIN))
square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
square.paste(drawing, ((side - drawing.width) // 2, (side - drawing.height) // 2))
icon = square.resize((512, 512), Image.LANCZOS)

for path in ("public/video-sage-logo.png", "src-tauri/icons/icon.png"):
    icon.save(ROOT / path)
for path in ("public/icon.ico", "src-tauri/icons/icon.ico"):
    icon.save(ROOT / path, format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print(f"drawing box ({left}, {top}, {right}, {bottom})")
