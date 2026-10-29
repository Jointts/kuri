"""Builds Kurimanju's walk cycle (walk-0 .. walk-7) from a four-pose sprite sheet.

The four poses are cut from the sheet (white background and grey ground shadow removed) and brought to one scale and one
ground line; the cycle is the four poses in order. (Optical-flow in-betweens were tried and dropped: flat cream shapes
give the flow nothing to track, so the legs ghosted.)

usage: python3 build-walk-sheet.py <sprite sheet.png> <existing frames dir> <output dir>
needs: numpy, Pillow, opencv-python-headless (for the cutout).
The output dir gets a copy of the existing frames with the walk-*.png replaced; bake-assets.py reads that.
"""
import shutil
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

sheet_path, frames_dir, out_dir = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])

FRAME_W, FRAME_H = 220, 240        # the delivered size the rest of the frames use (20 px per world pixel)
GROUND = 233                       # lowest pixel of every frame sits here
TARGET_HEIGHT = 199                # the old walk frames' height, so he keeps his size on screen
CENTER_X = FRAME_W / 2
KEYS = 4


def cut_poses(path: Path) -> list[np.ndarray]:
    """The poses as straight RGBA arrays, left to right, tightly cropped."""
    src = np.array(Image.open(path).convert("RGB"))
    nonwhite = (src.min(axis=2) < 235).any(axis=0)
    runs, start = [], None
    for x, on in enumerate(nonwhite):
        if on and start is None:
            start = x
        if not on and start is not None:
            runs.append((start, x - 1))
            start = None
    if start is not None:
        runs.append((start, len(nonwhite) - 1))
    runs = [r for r in runs if r[1] - r[0] > 100]
    if len(runs) != KEYS:
        raise SystemExit(f"expected {KEYS} poses on the sheet, found {len(runs)}: {runs}")
    return [cut(src, x0, x1) for x0, x1 in runs]


def cut(src: np.ndarray, x0: int, x1: int) -> np.ndarray:
    pad = 14
    crop = src[:, max(0, x0 - pad):x1 + pad + 1].copy()
    h, w = crop.shape[:2]
    rgb = crop.astype(int)
    mx, mn, mean = rgb.max(axis=2), rgb.min(axis=2), rgb.mean(axis=2)
    # the background is the near-white that connects to the border
    _, lab = cv2.connectedComponents((mn >= 236).astype(np.uint8), connectivity=4)
    border = set(lab[0, :]) | set(lab[-1, :]) | set(lab[:, 0]) | set(lab[:, -1])
    bg = np.isin(lab, [label for label in border if label != 0])
    # the ground shadow is the big mid-grey blob; grow it a little over its soft edge, but never over ink or cream
    grey = ((mx - mn) < 18) & (mean > 120) & (mean < 232) & ~bg
    n, lab, stats, _ = cv2.connectedComponentsWithStats(grey.astype(np.uint8), connectivity=8)
    shadow = np.zeros_like(bg)
    for label in range(1, n):
        if stats[label, cv2.CC_STAT_AREA] > 2500:
            shadow |= lab == label
    # white slivers left under the feet by the shadow's edge (the eye highlight is far above, so the lower part is safe)
    sliver = (mean > 185) & ((mx - mn) < 16) & (np.arange(h)[:, None] > 0.75 * h)
    gone = bg | sliver
    alpha = np.where(gone, 0, 255).astype(np.float32)
    out = np.zeros((h, w, 4), np.uint8)
    out[:, :, :3] = crop
    # Next to the shadow, every low-saturation pixel is ink mixed with the shadow's grey: read how much ink from where
    # it sits between that grey and black. The shadow itself comes out at 0, the outline keeps a soft anti-aliased edge.
    shadow_grey = float(np.median(mean[shadow])) if shadow.any() else 175.0
    near_shadow = (cv2.dilate(shadow.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0) & ((mx - mn) < 30) & ~bg
    ink_alpha = np.clip((shadow_grey - mean) / (shadow_grey - 35), 0, 1) * 255
    # the AI-drawn edge is noisy where it met the shadow: keep only the clear ink, then let a small blur re-anti-alias it
    clear_ink = np.where(near_shadow & (ink_alpha > 110), 255.0, 0.0).astype(np.float32)
    alpha[near_shadow] = cv2.GaussianBlur(clear_ink, (0, 0), 1.3)[near_shadow]
    out[near_shadow, :3] = (40, 25, 25)
    # an outline's anti-aliased edge against the white background reads as light grey: make it partial ink instead
    near_bg = cv2.dilate(gone.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    rim = near_bg & ~gone & ~near_shadow & ((mx - mn) < 30) & (mean >= 60)
    out[rim, :3] = (40, 25, 25)
    alpha[rim] = (np.clip((250 - mean) / (250 - 35), 0, 1) * 255)[rim]
    out[:, :, 3] = alpha.astype(np.uint8)
    ys, xs = np.where(out[:, :, 3] > 0)
    return out[ys.min():ys.max() + 1, xs.min():xs.max() + 1]


def body_center(rgba: np.ndarray) -> float:
    """Centre x of the widest unbroken run in the upper half: the body, not the arms or feet."""
    solid = rgba[:, :, 3] > 0
    h = solid.shape[0]
    best, centre = 0, solid.shape[1] / 2
    for y in range(int(h * 0.15), int(h * 0.65)):
        run = start = 0
        for x, on in enumerate(solid[y]):
            if on:
                if run == 0:
                    start = x
                run += 1
                if run > best:
                    best, centre = run, start + run / 2
            else:
                run = 0

    return centre


def place(rgba: np.ndarray, scale: float) -> np.ndarray:
    """Onto the delivery canvas: body centre on the axis, lowest pixel on the ground line."""
    h, w = rgba.shape[:2]
    small = np.array(Image.fromarray(rgba).resize((round(w * scale), round(h * scale)), Image.LANCZOS))
    canvas = np.zeros((FRAME_H, FRAME_W, 4), np.uint8)
    ox, oy = round(CENTER_X - body_center(rgba) * scale), GROUND + 1 - small.shape[0]
    for y in range(small.shape[0]):
        for x in range(small.shape[1]):
            cx, cy = ox + x, oy + y
            if 0 <= cx < FRAME_W and 0 <= cy < FRAME_H:
                canvas[cy, cx] = small[y, x]

    return canvas


def main() -> None:
    poses = cut_poses(sheet_path)
    scale = TARGET_HEIGHT / (sum(p.shape[0] for p in poses) / len(poses))
    placed = [place(p, scale) for p in poses]
    cycle = placed

    out_dir.mkdir(parents=True, exist_ok=True)
    for path in frames_dir.glob("*.png"):
        if not path.name.startswith("walk-"):
            shutil.copy(path, out_dir / path.name)
    for stale in out_dir.glob("walk-*.png"):
        stale.unlink()
    for i, frame in enumerate(cycle):
        Image.fromarray(frame).save(out_dir / f"walk-{i}.png", optimize=True)
    print(f"wrote {len(cycle)} walk frames to {out_dir} (scale {scale:.3f})")


main()
