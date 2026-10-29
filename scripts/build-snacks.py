"""Rebuilds the pizza and taco frames (eat-pizza-{0,1}.png, eat-taco-{0,1}.png) so the hands are his own.

The pi extension built them from the resting pose with a round paw disc stamped on each side of the food, so his real
arms hung unused at his sides and he seemed to have four hands. Here his arms stretch out from his sides to the food
(outlined tubes over the belly, like the arm in the beer-drinking pose), and his own mitten, taken from the beer art, is
at the end of each, over the food's edge.

usage: python3 build-snacks.py <pi-jar-kurimanju>/packages/pi-kurimanju/scripts/build-kuri-frames.py \
         <reference dir with 01_idle_neutral.png, 02_beer_neutral.png and 03_beer_drinking.png> <food-stickers.png> \
         <existing frames dir> <output dir>
The output dir gets a copy of the existing frames with the four eat-*.png replaced.
needs: numpy, Pillow, opencv-python-headless.
"""
import importlib.util
import shutil
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location("build_drinks", HERE / "build-drinks.py")
drinks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drinks)

ARM_SHOULDER = 54      # the arm's cream core where it leaves his side, in canvas pixels: chubby like the walking pose's arm
ARM_WRIST = 46         # ... and at the hand, so it tapers a little
ARM_OUTLINE = 12
HAND_HEIGHT = 136      # the mitten, outline included
# His resting arms are small stubs on his lower sides (canvas pixels, read off the idle pose): the new arms grow out of
# them, so the stub is the shoulder and he is left with no extra limbs.
SHOULDERS = ((232, 905), (898, 905))


# The taco: smaller than the pizza (it was covering his whole lower face) and lower, so his mouth is clear above its top edge.
TACO_HEIGHT = 320
TACO_Y = 885            # centre of the taco, canvas pixels
TACO_HANDS_DX = 190     # how far each hand is from the middle
TACO_HANDS_DY = 70      # ... and below the taco's centre
CHEESE_CUT_Y = 54      # rows of the placed pizza sticker above this are cut off: its stringy cheese tip looked like a hand


def trim_cheese(pizza: Image.Image) -> Image.Image:
    """The slice without the cheese strand that sticks out of its tip, with an outline drawn along the new top edge."""
    a = np.array(pizza)
    cut = np.zeros(a.shape[:2], bool)
    cut[:CHEESE_CUT_Y] = True
    a[cut] = 0
    # the sticker's outline is a dark band; give the cut edge the same, so the tip looks drawn that way and not sliced
    band = (cv2.dilate(cut.astype(np.uint8), np.ones((33, 5), np.uint8)) > 0) & ~cut & (a[:, :, 3] > 0)
    band &= np.arange(a.shape[0])[:, None] < CHEESE_CUT_Y + 16
    a[band] = (*drinks.b.INK[:3], 255)
    return Image.fromarray(a)


# His face, in canvas pixels: the closed mouth (and the little line under it) of the resting pose. The open mouth is the HAAAA one
# (drinks.open_mouth_sprite), which is what he opens when he is done with a beer; it sits at the same x.
CLOSED_MOUTH_BOX = (495, 605, 640, 712)
MOUTH_TOP = (565, 610)      # where the top of the open mouth goes: x centre, y of the top


def with_open_mouth(pose: Image.Image, mouth: Image.Image, scale: float) -> Image.Image:
    """The pose with its closed mouth wiped off and the open one drawn `scale` as big, its top where the closed one's was."""
    out = pose.copy()
    x0, y0, x1, y1 = CLOSED_MOUTH_BOX
    beige = pose.getpixel((x0 - 20, y1 + 10))
    ImageDraw.Draw(out).rectangle((x0, y0, x1, y1), fill=beige)
    sized = mouth.resize((round(mouth.width * scale), round(mouth.height * scale)), Image.LANCZOS)
    out.alpha_composite(sized, (round(MOUTH_TOP[0] - sized.width / 2), MOUTH_TOP[1]))
    return out


def outlined_mitten(pose) -> Image.Image:
    """His mitten with an outline all the way round. In the beer art one side hides behind the can, so there the outline
    is the can's; rebuild it: ink grown round the cream, the cream on top."""
    cream, _ = pose.hand_cream()
    ink = cv2.dilate(cream.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (33, 33))) > 0
    out = np.zeros(cream.shape + (4,), np.uint8)
    out[ink] = (*drinks.b.INK[:3], 255)
    art = np.array(pose.art)
    out[cream] = art[cream]
    # a soft edge: the grown ink mask is hard, so blur its alpha a little
    alpha = cv2.GaussianBlur(out[:, :, 3].astype(np.float32), (0, 0), 1.2)
    out[:, :, 3] = alpha.astype(np.uint8)
    image = Image.fromarray(out)
    image = image.crop(image.getchannel("A").getbbox())
    return image.resize((round(image.width * HAND_HEIGHT / image.height), HAND_HEIGHT), Image.LANCZOS)


def arm(layer: Image.Image, shoulder, hand, cream) -> None:
    """A chubby arm from the shoulder to the hand, tapering a little: an outlined shape over the belly (ink first, the cream
    core on top), with rounded ends."""
    draw = ImageDraw.Draw(layer)
    s, h = np.array(shoulder, float), np.array(hand, float)
    direction = (h - s) / np.linalg.norm(h - s)
    normal = np.array([-direction[1], direction[0]])
    for grow, colour in ((ARM_OUTLINE, drinks.b.INK), (0, cream)):
        rs, rh = ARM_SHOULDER + grow, ARM_WRIST + grow
        quad = [tuple(s + normal * rs), tuple(h + normal * rh), tuple(h - normal * rh), tuple(s - normal * rs)]
        fill = tuple(colour)[:3] + (255,)
        draw.polygon(quad, fill=fill)
        for centre, radius in ((s, rs), (h, rh)):
            draw.ellipse((centre[0] - radius, centre[1] - radius, centre[0] + radius, centre[1] + radius), fill=fill)


def arms(layer: Image.Image, cream, hands) -> None:
    """Both arms out to `hands` (left then right). Drawn before the food, so the food hides the middle of each arm; the
    caller draws the mittens after the food."""
    for shoulder, hand in zip(SHOULDERS, hands):
        arm(layer, shoulder, hand, cream)


def mitts(layer: Image.Image, mitten: Image.Image, hands, cream) -> None:
    """His mitten at the end of each arm. The mitten is outlined all the way round, which would draw a line across the wrist
    where the arm joins it, so a cream bridge from the hand back along the arm opens that side of the outline."""
    draw = ImageDraw.Draw(layer)
    for side, shoulder, (hx, hy) in zip((-1, 1), SHOULDERS, hands):
        hand = mitten if side > 0 else mitten.transpose(Image.FLIP_LEFT_RIGHT)
        layer.alpha_composite(hand, (round(hx - hand.width / 2), round(hy - hand.height / 2)))
        direction = np.array([shoulder[0] - hx, shoulder[1] - hy], float)
        direction /= np.linalg.norm(direction)
        start = np.array([hx, hy]) + direction * (HAND_HEIGHT * 0.22)
        end = np.array([hx, hy]) + direction * (HAND_HEIGHT * 0.62)
        draw.line([tuple(start), tuple(end)], fill=tuple(cream)[:3] + (255,), width=round((ARM_WRIST - 4) * 2))


def main() -> None:
    script, refs, stickers_path, frames_dir, out_dir = sys.argv[1:6]
    drinks.init(script, refs, stickers_path, frames_dir, out_dir)
    b = drinks.b
    stickers = b.sticker_cutouts(Path(stickers_path))
    mitten = outlined_mitten(drinks.Pose(drinks.HELD))
    idle = b.cut(Image.open(Path(refs) / "01_idle_neutral.png").convert("RGBA"))
    pose = b.place(idle, b.SCALES["01"])
    cream = pose.getpixel((b.CW // 2, b.GROUND - 300))
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    for path in Path(frames_dir).glob("*.png"):
        shutil.copy(path, out / path.name)

    pizza = trim_cheese(b.fit_height(b.tip_up(stickers["pizza"]), 540, 2.1))   # the eating pose only: leftovers keep the strand
    row = np.where(np.array(pizza.getchannel("A"))[round(pizza.height * 0.2)] > 0)[0]    # the slice's edges a fifth of the way down
    grip_y = b.GROUND + 6 - pizza.height + pizza.height * 0.2
    hands = [(b.CW / 2 - pizza.width / 2 + edge, grip_y + 20) for edge in (row.min(), row.max())]
    shout = drinks.open_mouth_sprite()
    for chomp in (0, 1):
        # a wide-open mouth for the bite, a smaller one for the chomp, so it chews
        layer = with_open_mouth(pose, shout, 0.62 if chomp else 0.9)
        arms(layer, cream, hands)
        b.put(layer, pizza, b.CW / 2, b.GROUND + 6 - pizza.height / 2)
        mitts(layer, mitten, hands, cream)
        frame = b.squash(layer, b.FOOD_BITE) if chomp else layer
        b.finish(frame).save(out / f"eat-pizza-{chomp}.png", optimize=True)

    taco = b.fit_height(stickers["taco"], TACO_HEIGHT, 1.0).rotate(8, expand=True, resample=Image.BICUBIC)
    for chomp in (0, 1):
        # the same open mouth as the pizza: wide for the bite, smaller for the chomp
        layer = with_open_mouth(pose, shout, 0.62 if chomp else 0.9)
        tilt = taco.rotate(-8 * chomp, expand=True, resample=Image.BICUBIC)
        lift = 22 * chomp
        hands = [(b.CW / 2 + side * TACO_HANDS_DX, TACO_Y + TACO_HANDS_DY - lift) for side in (-1, 1)]
        arms(layer, cream, hands)
        b.put(layer, tilt, b.CW / 2, TACO_Y - lift)
        mitts(layer, mitten, hands, cream)
        frame = b.squash(layer, b.FOOD_BITE) if chomp else layer
        b.finish(frame).save(out / f"eat-taco-{chomp}.png", optimize=True)
    print(f"wrote 4 snack frames to {out}")


if __name__ == "__main__":
    main()
