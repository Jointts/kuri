"""Rebuilds the wine and lime drinking frames (drink-{wine,lime}-{0,1}.png) so the hand is his own.

The pi extension built them from the resting pose with a round paw disc stamped on the bottle, so his real arm hung
at his side and a second hand floated on the bottle. The beer poses are drawn the right way: his own arm is bent up and
the mitten wraps the can. So here the bottle goes into those poses instead:
  - the can (interior, lid, ring-pull, outline, anti-aliased fringe) is erased and the blush it hid is finished,
  - the bottle is placed where the can was, upright in the hand (drink-*-0, from the beer-neutral pose) or tipped to
    his mouth (drink-*-1, from the beer-drinking pose),
  - his mitten (the cream hand and its outline, flood-filled out of the original art) is drawn over the bottle.

usage: python3 build-drinks.py <pi-jar-kurimanju>/packages/pi-kurimanju/scripts/build-kuri-frames.py \
         <reference dir with 02_beer_neutral.png and 03_beer_drinking.png> <food-stickers.png> \
         <existing frames dir> <output dir>
The output dir gets a copy of the existing frames with the four drink-*.png replaced.
needs: numpy, Pillow, opencv-python-headless.
"""
import importlib.util
import math
import shutil
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw

b = refs = stickers_path = frames_dir = out_dir = None   # set by init()


def init(script, refs_dir, stickers, frames, out) -> None:
    """Load the pi build script and remember the paths (separate from main() so build-snacks.py can reuse the mitten)."""
    global b, refs, stickers_path, frames_dir, out_dir
    refs, stickers_path, frames_dir, out_dir = Path(refs_dir), Path(stickers), Path(frames), Path(out)
    spec = importlib.util.spec_from_file_location("kuri_build", script)
    b = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(b)

ELLIPSE = cv2.MORPH_ELLIPSE
# In each beer pose's artwork (1254 x 1254), found by looking at it:
HELD = dict(ref="02_beer_neutral.png", scale_key="02", hand_seed=(985, 860), hand_box=(900, 770, 1060, 930), cream=(600, 800),
            lid_radius=60, protect=None)
SIP = dict(ref="03_beer_drinking.png", scale_key="03", hand_seed=(300, 680), hand_box=(200, 560, 400, 790), cream=(700, 900),
           lid_radius=58, protect=(415, 450, 485, 548),     # protect: the eye, which the lid-erase would clip
           mouth_clear=(556, 596, 58))                      # his closed-mouth lips and corner: replaced by an open mouth
# Tipped to his mouth: the neck tip goes into his (open) mouth and the mitten grips the bottle `grip` of the way down it
# (near the base, like holding it to drink), so the bottle lies along the line from his hand to his mouth.
SIP_BOTTLE = dict(mouth=(556, 596), grip=0.88, min_height=300, push=13)
# His head is tilted in the drinking pose: left eye (451, 493), right eye (689, 545), so the mouth is turned to match.
SIP_HEAD_TILT = 12.3       # degrees, clockwise
SIP_MOUTH_SCALE = 0.9      # of the HAAAA mouth, as in the pizza's bite (in canvas pixels)
# The HAAAA mouth in the shouting pose, in canvas pixels (the same x as the resting pose's closed mouth):
OPEN_MOUTH_BOX = (495, 608, 640, 782)
HELD_BOTTLE = dict(height=430, centre=(905, 840))           # upright, the mitten over its right edge


class Pose:
    """One beer pose: its art, the can's masks and the mitten, all in the artwork's pixel space."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.art = b.cut(Image.open(refs / cfg["ref"]).convert("RGBA"))
        a = np.array(self.art).astype(int)
        self.rgb, self.alpha = a[:, :, :3], a[:, :, 3] > 0
        mean = self.rgb.mean(axis=2)
        sat = self.rgb.max(axis=2) - self.rgb.min(axis=2)
        # the can is the biggest patch of light grey
        grey = self.alpha & (sat < 22) & (mean > 150) & (mean < 245)
        n, lab, stats, _ = cv2.connectedComponentsWithStats(grey.astype(np.uint8), connectivity=8)
        self.can = lab == (1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA])))
        self.can_full = (cv2.dilate(self.can.astype(np.uint8), cv2.getStructuringElement(ELLIPSE, (35, 35))) > 0) & self.alpha
        self.ink = self.alpha & (mean < 110)
        self.region = self._hand_region()

    def _hand_region(self):
        """The cream of the mitten: flood-fill between ink outlines, boxed in and held off the can."""
        cream = self.alpha & ~self.ink & ~(cv2.dilate(self.can.astype(np.uint8), cv2.getStructuringElement(ELLIPSE, (35, 35))) > 0)
        x0, y0, x1, y1 = self.cfg["hand_box"]
        boxed = np.zeros_like(cream)
        boxed[y0:y1, x0:x1] = True
        _, lab = cv2.connectedComponents((cream & boxed).astype(np.uint8), connectivity=4)
        seed = self.cfg["hand_seed"]
        label = lab[seed[1], seed[0]]
        if not label:
            raise SystemExit(f"{self.cfg['ref']}: the hand seed {seed} is not on cream")
        return lab == label

    def hand_cream(self, reach=48):
        """The cream of the mitten alone (no outline): the flood region held to what is near the hand's own outline."""
        ring = cv2.dilate(self.region.astype(np.uint8), cv2.getStructuringElement(ELLIPSE, (29, 29))) > 0
        outline = self.ink & ring & ~self.can_full
        # the flood leaks into plain belly cream where the can hid the join: keep what is near the hand's own outline
        dist = cv2.distanceTransform((~outline).astype(np.uint8), cv2.DIST_L2, 5)
        return self.region & (dist <= reach), ring

    def mitten(self, reach=48):
        cream, ring = self.hand_cream(reach)
        keep = cream | (ring & self.ink)
        out = np.array(self.art)
        out[~keep] = 0
        return Image.fromarray(out)

    def hand_centre(self):
        """Where the mitten is: the middle of its sprite."""
        ys, xs = np.where(np.array(self.mitten())[:, :, 3] > 0)
        return np.array([xs.mean(), ys.mean()])

    def without_can(self):
        a = np.array(self.art)
        cream = a[self.cfg["cream"][1], self.cfg["cream"][0]].copy()
        rgb, alpha = self.rgb, self.alpha
        near = cv2.dilate(self.can.astype(np.uint8), cv2.getStructuringElement(ELLIPSE, (2 * self.cfg["lid_radius"] + 1,) * 2)) > 0
        differs = np.abs(rgb - cream[:3].astype(int)).sum(axis=2) > 18
        pink = (rgb[:, :, 0] - rgb[:, :, 1] > 35) & (rgb[:, :, 2] > 170) & alpha
        n, lab, stats, _ = cv2.connectedComponentsWithStats(pink.astype(np.uint8), connectivity=8)
        # the big pink blobs are the blush (kept with its hatching); the small one is the lips (only the pixels themselves)
        keep_blush = np.zeros(pink.shape, bool)
        keep_lips = np.zeros(pink.shape, bool)
        self.lips_colour = (240, 150, 170)
        for label in range(1, n):
            big = stats[label, cv2.CC_STAT_AREA] > 4000
            grown = cv2.dilate((lab == label).astype(np.uint8), cv2.getStructuringElement(ELLIPSE, (61 if big else 9,) * 2)) > 0
            if big:
                keep_blush |= grown
            else:
                keep_lips |= grown
                self.lips_colour = tuple(int(v) for v in np.median(rgb[lab == label], axis=0))
        keep_blush |= cv2.distanceTransform(alpha.astype(np.uint8), cv2.DIST_L2, 5) < 30      # the body outline
        keep = keep_blush | keep_lips
        if self.cfg["protect"]:
            x0, y0, x1, y1 = self.cfg["protect"]
            keep[y0:y1, x0:x1] = True
        erase = self.can_full | (near & alpha & differs & ~keep)
        if self.cfg.get("mouth_clear"):
            mx, my, radius = self.cfg["mouth_clear"]
            yy, xx = np.mgrid[0:alpha.shape[0], 0:alpha.shape[1]]
            erase |= ((xx - mx) ** 2 + (yy - my) ** 2 <= radius ** 2) & alpha & differs & ~keep_blush
        a[erase] = cream
        # the can hid part of the blush: finish its ellipse (fitted to the visible pink) inside the erased area
        for label in range(1, n):
            if stats[label, cv2.CC_STAT_AREA] <= 4000:
                continue
            comp = lab == label
            closed = cv2.morphologyEx(comp.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((41, 41), np.uint8))   # hatching splits it
            contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
            ellipse = cv2.fitEllipse(max(contours, key=cv2.contourArea))
            fill = np.zeros(pink.shape, np.uint8)
            cv2.ellipse(fill, ellipse, 1, -1)
            a[(fill > 0) & erase] = np.append(np.median(rgb[comp], axis=0).astype(np.uint8), 255)
        return Image.fromarray(a)

    def can_axis(self):
        """Unit vector along the can, pointing up and to the right (toward the mouth in the drinking pose)."""
        ys, xs = np.where(self.can)
        pts = np.stack([xs, ys], 1).astype(np.float64)
        centre = pts.mean(axis=0)
        _, vectors = np.linalg.eigh(np.cov((pts - centre).T))
        d = vectors[:, 1]
        return d if d[0] >= 0 else -d

    def finish(self, layer: Image.Image) -> Image.Image:
        """Onto the delivery canvas, anchored exactly like the pose's own frame."""
        placed = b.place(layer, b.SCALES[self.cfg["scale_key"]], metrics=b.head_metrics(self.art))
        return b.finish(placed)


def tilt(bottle: Image.Image, degrees: float) -> Image.Image:
    rotated = bottle.rotate(degrees, expand=True, resample=Image.BICUBIC)
    return rotated.crop(rotated.getchannel("A").getbbox())


def put(layer: Image.Image, art: Image.Image, centre) -> None:
    layer.alpha_composite(art, (round(centre[0] - art.width / 2), round(centre[1] - art.height / 2)))


def open_mouth_sprite() -> Image.Image:
    """The HAAAA mouth cut out of the shouting pose, with no face behind it: everything that is not the pose's own beige,
    with its inside filled (the teeth are light). In canvas pixels at the resting pose's scale."""
    shout = b.place(b.cut(Image.open(refs / "04_beer_haaaa.png").convert("RGBA")), b.SCALES["04"])
    face = shout.crop(OPEN_MOUTH_BOX)
    rgb = np.array(face).astype(int)[:, :, :3]
    beige = np.array(shout.getpixel((560, 900)))[:3].astype(int)
    mask = (np.abs(rgb - beige).sum(axis=2) > 30).astype(np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    filled = np.zeros_like(mask)
    cv2.drawContours(filled, contours, -1, 1, -1)
    out = np.array(face)
    out[:, :, 3] = cv2.GaussianBlur(filled.astype(np.float32) * 255, (0, 0), 0.8).astype(np.uint8)
    return Image.fromarray(out)


def sip_mouth(sip: "Pose") -> Image.Image:
    """The open mouth for the drinking pose, in that pose's artwork pixels: sized like the pizza's, turned with the head."""
    sprite = open_mouth_sprite()
    size = SIP_MOUTH_SCALE / b.SCALES[sip.cfg["scale_key"]]       # the pose is drawn at its own scale on the canvas
    sprite = sprite.resize((round(sprite.width * size), round(sprite.height * size)), Image.LANCZOS)
    return sprite.rotate(-SIP_HEAD_TILT, expand=True, resample=Image.BICUBIC)


def main() -> None:
    init(*sys.argv[1:6])
    stickers = b.sticker_cutouts(stickers_path)
    held, sip = Pose(HELD), Pose(SIP)
    out_dir.mkdir(parents=True, exist_ok=True)
    for path in frames_dir.glob("*.png"):
        shutil.copy(path, out_dir / path.name)

    for name, lean in (("wine", 14), ("lime", 0)):
        bottle = stickers[name] if not lean else tilt(stickers[name], lean)

        layer = held.without_can()
        put(layer, b.fit_height(bottle, HELD_BOTTLE["height"]), HELD_BOTTLE["centre"])
        layer.alpha_composite(held.mitten())
        held.finish(layer).save(out_dir / f"drink-{name}-0.png", optimize=True)

        layer = sip.without_can()
        mouth_sprite = sip_mouth(sip)
        mouth, grip = np.array(SIP_BOTTLE["mouth"], float), sip.hand_centre()
        d = (mouth - grip) / np.linalg.norm(mouth - grip)       # from the hand to the mouth, the way the neck points
        height = max(SIP_BOTTLE["min_height"], np.linalg.norm(mouth - grip) / SIP_BOTTLE["grip"])
        small = b.fit_height(bottle, height)                    # the straightened sticker: its axis is vertical, the neck on top
        angle = math.degrees(math.atan2(-d[0], -d[1]))
        centre = mouth + d * SIP_BOTTLE["push"] - d * (small.height / 2)
        layer.alpha_composite(mouth_sprite, (round(mouth[0] - mouth_sprite.width / 2), round(mouth[1] - mouth_sprite.height / 2)))
        put(layer, small.rotate(angle, expand=True, resample=Image.BICUBIC), centre)
        layer.alpha_composite(sip.mitten())
        sip.finish(layer).save(out_dir / f"drink-{name}-1.png", optimize=True)
    print(f"wrote 4 drink frames to {out_dir}")


if __name__ == "__main__":
    main()
