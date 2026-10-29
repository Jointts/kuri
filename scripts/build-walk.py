"""Rebuilds Kurimanju's walk cycle as 8 frames (walk-0 .. walk-7) from his own profile art.

The pi extension's walk was two poses on repeat with long stick feet and arms painted into the body. Here:
  - the original feet are erased from the body and the belly outline is redrawn where the front foot joined it,
  - the legs are the small round stubs of his resting pose: they only slide sideways under the belly (no lift, no bend),
    one forward while the other goes back, crossing in the middle, and they merge into the belly outline like at rest,
  - both arms are cut off the body and swing against each other, most at the foot strikes (walk-0 and walk-4),
  - the body leans a little side to side and bobs up slightly on the passing frames.

usage: python3 build-walk.py <pi-jar-kurimanju>/packages/pi-kurimanju/scripts/build-kuri-frames.py \
         <08_walking_profile.png> <existing frames dir> <output dir>
The output dir gets a copy of the existing frames with walk-*.png replaced; bake-assets.py reads that.
"""
import importlib.util
import math
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

script, reference, frames_dir, out_dir = sys.argv[1], sys.argv[2], Path(sys.argv[3]), Path(sys.argv[4])
spec = importlib.util.spec_from_file_location("kuri_build", script)
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)

PHASES = 8
ARM_SWING = 55      # degrees the back arm swings at the foot strikes
HAND_SWING = 22     # the front hand is attached to the belly outline, so it swings less or it would pull away from it
ROCK = 2.0          # degrees the body leans side to side, in time with the steps
BOB = 14            # how far the body rises on the passing frames, in 08's pixel space

# The resting pose's stubs, measured on open-0 and converted to 08's pixel space (about 4.9 per delivered pixel).
STUB_CENTER = 627   # the axis the stubs slide about
STUB_SPREAD = 150   # how far from the axis a stub goes at the foot strikes (at rest they sit about 157 either side)
STUB_INK = 43       # radius of the outline
STUB_CREAM = 30     # radius of the core, so the outline is about 13 thick
STUB_DROP = 52      # how far the stub's bottom hangs below the belly outline

# Everything below is in 08's pixel space (1254 x 1254), read off the cutout.
BACK_ARM = [(300, 705), (382, 772), (380, 802), (352, 842), (326, 866), (280, 862), (254, 822), (248, 760), (262, 724)]
BACK_PIVOT = (345, 735)
FRONT_BOX = (948, 770, 1064, 912)      # the hand is whatever lies right of the belly outline within this box
FRONT_OUTLINE_X = 966
FRONT_PIVOT = (964, 820)
# where the belly outline runs behind the back arm: top, bulge control, bottom
OUTLINE = ((301, 714), (284, 784), (318, 856))
INK, CREAM = b.INK, b.CREAM


def curve_points(steps: int = 60):
    (x0, y0), (cx, cy), (x1, y1) = OUTLINE
    return [((1 - t) ** 2 * x0 + 2 * (1 - t) * t * cx + t * t * x1, (1 - t) ** 2 * y0 + 2 * (1 - t) * t * cy + t * t * y1)
            for t in (i / steps for i in range(steps + 1))]


def remove_old_feet(body: Image.Image) -> Image.Image:
    """body_only keeps the feet that lie against the belly outline; erase the front foot and the back foot's leftovers,
    and redraw the belly outline where the front foot joined it."""
    data = np.array(body)
    h, w = data.shape[:2]
    ys, xs = np.mgrid[0:h, 0:w]
    front = Image.new("L", body.size, 0)
    ImageDraw.Draw(front).polygon([(772, 1026), (850, 997), (910, 990), (912, 1110), (778, 1110)], fill=255)
    back = (xs >= 335) & (xs <= 450) & (ys >= 945) & (ys <= 1045) & (ys > 950 + 0.815 * (xs - 355) + 12)
    data[(np.array(front) > 0) | back] = 0
    out = Image.fromarray(data)
    pts = [((1 - t) ** 2 * 770 + 2 * (1 - t) * t * 815 + t * t * 852, (1 - t) ** 2 * 1022 + 2 * (1 - t) * t * 1008 + t * t * 993)
           for t in (i / 40 for i in range(41))]
    ImageDraw.Draw(out).line(pts, fill=INK, width=15, joint="curve")
    return out


def split_arms(body: Image.Image):
    """(body without arms, back arm sprite, front hand sprite), all full size so they share coordinates."""
    size = body.size
    data = np.array(body)
    back_mask = Image.new("L", size, 0)
    ImageDraw.Draw(back_mask).polygon(BACK_ARM, fill=255)
    back_in = np.array(back_mask) > 0
    front_in = np.zeros(back_in.shape, bool)
    x0, y0, x1, y1 = FRONT_BOX
    front_in[y0:y1, FRONT_OUTLINE_X:x1] = True

    back_sprite = data.copy()
    back_sprite[~back_in] = 0
    front_sprite = data.copy()
    front_sprite[~front_in] = 0

    bare = data.copy()
    bare[back_in | front_in] = 0
    bare_img = Image.fromarray(bare)
    # Patch where the back arm hid the belly: cream right of the outline curve, the outline itself drawn on top.
    curve = curve_points()
    left = Image.new("L", size, 0)
    ImageDraw.Draw(left).polygon(curve + [(150, curve[-1][1]), (150, curve[0][1])], fill=255)
    patch = back_in & ~(np.array(left) > 0)
    layer = np.array(bare_img)
    layer[patch] = CREAM
    bare_img = Image.fromarray(layer)
    ImageDraw.Draw(bare_img).line(curve, fill=INK, width=15, joint="curve")
    for x, y in (curve[0], curve[-1]):
        ImageDraw.Draw(bare_img).ellipse((x - 7, y - 7, x + 7, y + 7), fill=INK)
    return bare_img, Image.fromarray(back_sprite), Image.fromarray(front_sprite)


def belly_bottom(bare: Image.Image, x: int) -> int:
    """The lowest opaque pixel of the belly around column x (the legs and arms are already cut away)."""
    alpha = np.array(bare)[:, max(0, x - 4):x + 5, 3]
    rows = np.where((alpha > 0).any(axis=1))[0]
    rows = rows[rows < 1120]
    return int(rows.max())


def stubs(bare: Image.Image, phase: int):
    """(layer under the body, layer over it): the two stubs, and the cream that opens the belly outline above each so
    the stub runs into the belly like the resting pose's do."""
    t = phase / PHASES
    under = Image.new("RGBA", bare.size, (0, 0, 0, 0))
    over = Image.new("RGBA", bare.size, (0, 0, 0, 0))
    belly_cream = bare.getpixel((STUB_CENTER, 900))
    for sign in (1, -1):
        x = round(STUB_CENTER + sign * STUB_SPREAD * math.cos(2 * math.pi * t))
        bottom = belly_bottom(bare, x)
        top, tip = bottom - 20, bottom + STUB_DROP - STUB_INK
        draw = ImageDraw.Draw(under)
        for radius, color in ((STUB_INK, INK), (STUB_CREAM, belly_cream)):
            draw.line([(x, top), (x, tip)], fill=color, width=radius * 2)
            for cy in (top, tip):
                draw.ellipse((x - radius, cy - radius, x + radius, cy + radius), fill=color)
        # open the belly outline across the stub's core, from inside the belly to the stub's round
        ImageDraw.Draw(over).rectangle((x - STUB_CREAM + 2, bottom - 18, x + STUB_CREAM - 2, bottom + 14), fill=belly_cream)
    return under, over


def frame(bare, back_arm, front_hand, phase: int) -> Image.Image:
    t = phase / PHASES
    swing = ARM_SWING * math.cos(2 * math.pi * t)
    hand_swing = HAND_SWING * math.cos(2 * math.pi * t)
    # 0 at the foot strikes (walk-0, walk-4), BOB on the passing frames
    bob = -round(BOB * math.sin(math.pi * (phase % (PHASES // 2)) / (PHASES // 2)))
    under, over = stubs(bare, phase)
    upper = Image.new("RGBA", bare.size, (0, 0, 0, 0))
    upper.alpha_composite(under)
    upper.alpha_composite(bare)
    upper.alpha_composite(over)
    upper.alpha_composite(back_arm.rotate(-swing, center=BACK_PIVOT, resample=Image.BICUBIC))
    upper.alpha_composite(front_hand.rotate(hand_swing, center=FRONT_PIVOT, resample=Image.BICUBIC))
    upper = upper.rotate(ROCK * math.cos(2 * math.pi * t), center=(STUB_CENTER, 1060), resample=Image.BICUBIC)
    canvas = Image.new("RGBA", bare.size, (0, 0, 0, 0))
    canvas.paste(upper, (0, bob), upper)
    return canvas


def main() -> None:
    art = b.cut(Image.open(reference).convert("RGBA"), walking=True)
    bare, back_arm, front_hand = split_arms(remove_old_feet(b.body_only(art)))
    frames = [frame(bare, back_arm, front_hand, p) for p in range(PHASES)]
    pinned = b.head_metrics(frames[0])

    out_dir.mkdir(parents=True, exist_ok=True)
    for path in frames_dir.glob("*.png"):
        if not path.name.startswith("walk-"):
            shutil.copy(path, out_dir / path.name)
    for stale in out_dir.glob("walk-*.png"):
        stale.unlink()
    for p, f in enumerate(frames):
        placed = b.place(f, b.SCALES["08"], metrics=pinned)
        b.finish(placed).save(out_dir / f"walk-{p}.png", optimize=True)
    print(f"wrote {PHASES} walk frames to {out_dir}")


main()
