"""Image helpers for desktop (resize before upload)."""

from __future__ import annotations

import base64
import io
from pathlib import Path

from PIL import Image

MAX_EDGE = 1280
JPEG_QUALITY = 82


def resize_to_jpeg_base64(path: Path, max_edge: int = MAX_EDGE, quality: int = JPEG_QUALITY) -> tuple[str, str]:
    """Return (base64, mime) JPEG resized so long edge <= max_edge."""
    with Image.open(path) as img:
        img = img.convert("RGB")
        w, h = img.size
        scale = min(1.0, max_edge / max(w, h))
        if scale < 1.0:
            img = img.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality, optimize=True)
        return base64.b64encode(buf.getvalue()).decode("ascii"), "image/jpeg"
