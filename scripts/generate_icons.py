"""Generate simple PWA icons for ReceiptAI."""
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:
    print("PIL not available")
    raise SystemExit(1)

icons_dir = Path(__file__).resolve().parent.parent / "icons"
icons_dir.mkdir(exist_ok=True)

for size in (192, 512):
    img = Image.new("RGBA", (size, size), (15, 118, 110, 255))
    draw = ImageDraw.Draw(img)
    margin = size // 6
    draw.rounded_rectangle(
        [margin, margin, size - margin, size - margin],
        radius=size // 8,
        fill=(20, 184, 166, 255),
    )
    # Simple receipt shape
    rx0 = size // 3
    ry0 = size // 4
    rx1 = size - size // 3
    ry1 = size - size // 5
    draw.rounded_rectangle([rx0, ry0, rx1, ry1], radius=size // 40, fill=(255, 255, 255, 255))
    # Receipt lines
    line_color = (15, 118, 110, 200)
    for i in range(4):
        y = ry0 + size // 8 + i * (size // 12)
        draw.rectangle([rx0 + size // 16, y, rx1 - size // 16, y + size // 48], fill=line_color)
    img.save(icons_dir / f"icon-{size}.png")
    print(f"Created icon-{size}.png")
