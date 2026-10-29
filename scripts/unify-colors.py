"""Makes Kurimanju's body beige the same in every frame.

The frames come from different artwork (the idle pose, the beer poses, the walking profile, the hangover pose, a
ChatGPT sheet...) and their beige differs by a few units, mostly in blue, which shows when one action follows another.
Every frame's beige is measured (the median of its large flat-beige area) and shifted to the beige of a reference frame.
The shift is applied with a smooth falloff by colour distance, so the beige keeps its shading while the ink, the
blush, the cap and the props (which are far from beige) are left alone.

usage: python3 unify-colors.py <frames dir> <output dir> [reference frame, default eat-pizza-0]
The output dir gets every PNG of the frames dir; the can and leftover sprites are copied unchanged.
needs: numpy, Pillow.
"""
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image

frames_dir, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
reference = sys.argv[3] if len(sys.argv) > 3 else "eat-pizza-0"
FALLOFF = 70      # L1 colour distance at which a pixel stops being moved
MIN_PIXELS = 800


def beige_of(rgba: np.ndarray):
    """The median beige of a frame's flat body area, or None if it has too little of it."""
    r, g, b, a = (rgba[:, :, i].astype(int) for i in range(4))
    flat = (a > 240) & (r > 236) & (g > 212) & (g < 250) & (b > 175) & (b < 238) & ((r - b) > 14) & ((r - b) < 62) & ((r - g) < 30)
    if flat.sum() < MIN_PIXELS:
        return None
    return np.array([np.median(rgba[:, :, i][flat]) for i in range(3)])


def shifted(rgba: np.ndarray, source: np.ndarray, target: np.ndarray) -> np.ndarray:
    rgb = rgba[:, :, :3].astype(np.float32)
    distance = np.abs(rgb - source).sum(axis=2)
    weight = np.clip(1 - distance / FALLOFF, 0, 1)[:, :, None]
    out = rgba.copy()
    out[:, :, :3] = np.clip(rgb + (target - source) * weight, 0, 255).round().astype(np.uint8)
    return out


def main() -> None:
    target = beige_of(np.array(Image.open(frames_dir / f"{reference}.png").convert("RGBA")))
    if target is None:
        raise SystemExit(f"{reference} has no flat beige to take the colour from")
    out_dir.mkdir(parents=True, exist_ok=True)
    changed = 0
    for path in sorted(frames_dir.glob("*.png")):
        if path.name.startswith(("can-", "item-")):
            shutil.copy(path, out_dir / path.name)
            continue
        rgba = np.array(Image.open(path).convert("RGBA"))
        source = beige_of(rgba)
        if source is None or np.abs(source - target).sum() == 0:
            shutil.copy(path, out_dir / path.name)
            continue
        Image.fromarray(shifted(rgba, source, target)).save(out_dir / path.name, optimize=True)
        changed += 1
    print(f"beige {tuple(int(v) for v in target)} from {reference}; shifted {changed} frames into {out_dir}")


main()
