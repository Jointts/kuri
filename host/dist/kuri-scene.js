import { ATLAS } from "./atlas.js";
import { MIN_WIDTH, SCENE_HEIGHT } from "./kuri-physics.js";
/**
 * Composites Kurimanju, the cans and impact sparks into one RGBA picture that is `cols` columns by six rows, in
 * the physics world's coordinates (one world pixel = one column wide, half a row tall). The mod has no zlib, so the
 * sprites come from raw RGBA atlases (scripts/bake-assets.py) and the picture goes out as raw RGBA, never a PNG.
 */
export const SCENE_ROWS = SCENE_HEIGHT / 2;
/** The scene spans the band up to this many columns (wider means a bigger picture per repaint). */
export const MAX_SCENE_COLS = 56;
/** Image pixels per world pixel. The sprites are baked at this scale (the artwork is authored at 20 per world pixel). */
const PX = 16;
/** Pixel sizes from when the artwork was authored at 20 per world pixel, scaled to PX. */
const K = PX / 20;
const CAN_STEPS = 16;
const CAN_WORLD = 6;
const TWO_PI = Math.PI * 2;
const EFFECT_COLOR = [255, 236, 150];
const DUST_COLOR = [255, 255, 255];
export const BIT_LIFE_S = 0.7;
/** How long a particle on the floor takes to fade out at the end of its life. */
export const BIT_FADE_S = 1.0;
const BIT_GRAVITY = 60;
/** Where a bit is `age` (0 → 1) of the way through its life. */
export function bitTime(effect) { return Math.max(0, effect.age) * (effect.lifeS ?? BIT_LIFE_S); }
/** Whether a particle has reached the floor (it then rests there, and is drawn behind him). */
export const hasLanded = (effect) => effect.landS !== undefined && bitTime(effect) >= effect.landS;
/** 1 while it flies and rests, then fading to 0 over the last BIT_FADE_S seconds of its life. */
function bitAlpha(effect) {
    if (effect.landS === undefined) {
        return 1;
    }
    return Math.min(1, Math.max(0, ((effect.lifeS ?? BIT_LIFE_S) - bitTime(effect)) / BIT_FADE_S));
}
export function bitPosition(effect) {
    const t = Math.min(bitTime(effect), effect.landS ?? Infinity);
    return { x: effect.x + (effect.vx ?? 0) * t, y: effect.y + (effect.vy ?? 0) * t + 0.5 * BIT_GRAVITY * t * t };
}
/** Columns of scene for a band `width` columns wide; 0 when it cannot fit. */
export function sceneCols(width, max = MAX_SCENE_COLS) {
    const cols = Math.min(max, width);
    return cols < MIN_WIDTH ? 0 : cols;
}
/** Cans, and the empty can he drops after a beer, are drawn with the can sprites; everything else has its own item sprites. */
const usesCanSprites = (kind) => !kind || kind === "can" || kind === "beer";
/** Nearest of the sixteen pre-rendered can rotations. */
export function canFrameIndex(angle) {
    const turns = ((angle % TWO_PI) + TWO_PI) % TWO_PI / TWO_PI;
    return Math.round(turns * CAN_STEPS) % CAN_STEPS;
}
/**
 * Where a frame `widthWorld` wide is drawn: centred on him, but pulled back inside the scene. Most frames are the pet's
 * 11-column box; the 1.4x sleeping pose is wider than that, and would otherwise hang off the wall he fell asleep by.
 */
export function frameLeft(petX, widthWorld, cols) {
    return Math.max(0, Math.min(cols - widthWorld, petX - widthWorld / 2));
}
/** The passing frames of the 8-frame walk (2 and 6 are the highest) lift him slightly; together with the lift drawn into those frames this is the walking bob. */
const BOB = { "walk-1": -0.25, "walk-2": -0.5, "walk-3": -0.25, "walk-5": -0.25, "walk-6": -0.5, "walk-7": -0.25 };
/** Source-over blend of `src` (straight RGBA) onto `dst` at integer offset (x, y), optionally mirrored left-right. */
function blit(dst, src, x, y, mirror = false) {
    for (let sy = 0; sy < src.height; sy++) {
        const dy = y + sy;
        if (dy < 0 || dy >= dst.height) {
            continue;
        }
        for (let sx = 0; sx < src.width; sx++) {
            const dx = x + sx;
            if (dx < 0 || dx >= dst.width) {
                continue;
            }
            const from = (sy * src.width + (mirror ? src.width - 1 - sx : sx)) * 4;
            const alpha = src.data[from + 3];
            if (alpha === 0) {
                continue;
            }
            const to = (dy * dst.width + dx) * 4;
            const under = dst.data[to + 3];
            if (alpha === 255 || under === 0) {
                dst.data.set(src.data.subarray(from, from + 4), to);
                continue;
            }
            const a = alpha / 255, b = (under / 255) * (1 - a), out = a + b;
            for (let c = 0; c < 3; c++) {
                dst.data[to + c] = Math.round((src.data[from + c] * a + dst.data[to + c] * b) / out);
            }
            dst.data[to + 3] = Math.round(out * 255);
        }
    }
}
/** A filled circle blended onto `dst`; `soft` feathers its edge so overlapping blobs read as one cloud, not rings. */
function dot(dst, cx, cy, radius, color, alpha, soft = false) {
    for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
        for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
            const distance = Math.hypot(x - cx, y - cy);
            if (x < 0 || y < 0 || x >= dst.width || y >= dst.height || distance > radius) {
                continue;
            }
            const at = (y * dst.width + x) * 4;
            const a = soft ? alpha * Math.pow(1 - distance / radius, 0.55) : alpha, under = dst.data[at + 3] / 255, out = a + under * (1 - a);
            for (let c = 0; c < 3; c++) {
                dst.data[at + c] = Math.round((color[c] * a + dst.data[at + c] * under * (1 - a)) / out);
            }
            dst.data[at + 3] = Math.round(out * 255);
        }
    }
}
/** Six rays that grow and fade: the little impact flash. */
function spark(dst, effect) {
    const reach = (0.6 + 1.9 * effect.age) * (0.7 + 0.5 * effect.strength) * PX;
    const alpha = Math.max(0, 1 - effect.age * effect.age);
    for (let ray = 0; ray < 6; ray++) {
        const angle = (ray / 6) * TWO_PI + effect.x * 0.7;
        for (let d = reach * 0.45; d <= reach; d += Math.max(1, 2 * K)) {
            dot(dst, effect.x * PX + Math.cos(angle) * d, effect.y * PX + Math.sin(angle) * d, Math.max(0.9, (3.2 - 1.6 * (d / reach)) * K), EFFECT_COLOR, alpha);
        }
    }
}
/** A crumb or drop: a small solid dot that holds its colour and shrinks away over the last quarter of its life. */
function bit(dst, effect) {
    if (effect.age < 0 || effect.age >= 1) {
        return;
    }
    const { x, y } = bitPosition(effect);
    const alpha = bitAlpha(effect);
    const shrink = effect.landS !== undefined || effect.age < 0.75 ? 1 : (1 - effect.age) / 0.25;
    if (effect.shape) {
        piece(dst, effect, x * PX, y * PX, (effect.size ?? 0.5) * PX * shrink, alpha);
        return;
    }
    if (effect.stretch === undefined) {
        dot(dst, x * PX, y * PX, (effect.size ?? 0.5) * PX * shrink, effect.color ?? EFFECT_COLOR, alpha);
        return;
    }
    drop(dst, effect, x * PX, y * PX, (effect.size ?? 0.5) * PX * shrink, alpha);
}
/**
 * A drop of drink: an ellipse stretched along the way it is going (faster means longer), the way a real droplet smears,
 * with a soft edge, and a small pale highlight on the bigger ones. Position and velocity come from the same flight as a crumb.
 */
function drop(dst, effect, cx, cy, radius, alpha = 1) {
    const t = Math.min(bitTime(effect), effect.landS ?? Infinity);
    const landed = hasLanded(effect);
    const vx = effect.vx ?? 0, vy = (effect.vy ?? 0) + BIT_GRAVITY * t;
    const speed = Math.hypot(vx, vy);
    // on the floor a drop has splashed flat: a wide, low ellipse
    const ux = landed ? 1 : speed > 1e-6 ? vx / speed : 0, uy = landed ? 0 : speed > 1e-6 ? vy / speed : 1;
    const k = landed ? 1.5 : Math.min(1.8, speed / 30) * (effect.stretch ?? 1);
    const a = radius * (1 + k), b = Math.max(0.6, radius / Math.sqrt(1 + k)); // along the path, across it: roughly the same area
    const reach = Math.ceil(a + 1.5);
    const colour = effect.color ?? EFFECT_COLOR;
    for (let y = Math.floor(cy - reach); y <= Math.ceil(cy + reach); y++) {
        for (let x = Math.floor(cx - reach); x <= Math.ceil(cx + reach); x++) {
            if (x < 0 || y < 0 || x >= dst.width || y >= dst.height) {
                continue;
            }
            const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
            const along = (dx * ux + dy * uy) / a, across = (-dx * uy + dy * ux) / b;
            const f = Math.hypot(along, across);
            const cover = Math.min(1, Math.max(0, (1 - f) * Math.min(a, b) + 0.5)) * alpha; // about one pixel of soft edge
            if (cover <= 0) {
                continue;
            }
            // a pale highlight in the upper-left of the bigger drops, which is what makes a drop look wet
            const glint = radius > PX * 0.3 && Math.hypot(dx + radius * 0.35, dy + radius * 0.4) < radius * 0.3 ? 0.55 : 0;
            const rgb = colour.map((v) => v + (255 - v) * glint);
            const at = (y * dst.width + x) * 4, under = dst.data[at + 3] / 255, out = cover + under * (1 - cover);
            for (let c = 0; c < 3; c++) {
                dst.data[at + c] = Math.round((rgb[c] * cover + dst.data[at + c] * under * (1 - cover)) / out);
            }
            dst.data[at + 3] = Math.round(out * 255);
        }
    }
}
/**
 * A piece of food, tumbling: a shred (lettuce) is long and thin, a chunk (tomato, pepperoni) is blocky with rounded corners, a crumb
 * is lumpy. Each is a rotated superellipse (its exponent sets how square it is), turning as it flies, with a slightly darker rim
 * so it reads as a solid piece and not a blob.
 */
function piece(dst, effect, cx, cy, radius, alpha = 1) {
    const t = Math.min(bitTime(effect), effect.landS ?? Infinity); // it stops turning when it lands
    const landed = hasLanded(effect);
    // on the floor it lies flat: only a slight tilt (its own, from how it was turned), and a wide low shape
    const tilt = Math.sin(effect.angle0 ?? 0) * 0.18;
    const angle = landed ? tilt : (effect.angle0 ?? 0) + (effect.spin ?? 0) * t;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const aspect = effect.aspect ?? 1;
    const shred = effect.shape === "shred", chunk = effect.shape === "chunk";
    const a = radius * (shred ? 1 + aspect : Math.sqrt(aspect)) * (landed && !shred ? 1.3 : 1);
    const b = radius * (shred ? 0.45 : 1 / Math.sqrt(aspect)) * (landed && !shred ? 0.5 : 1);
    const power = chunk ? 3.2 : shred ? 4 : 2.3;
    const reach = Math.ceil(Math.max(a, b) * 1.45 + 1.5);
    const colour = effect.color ?? EFFECT_COLOR;
    for (let y = Math.floor(cy - reach); y <= Math.ceil(cy + reach); y++) {
        for (let x = Math.floor(cx - reach); x <= Math.ceil(cx + reach); x++) {
            if (x < 0 || y < 0 || x >= dst.width || y >= dst.height) {
                continue;
            }
            const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
            const u = (dx * cos + dy * sin) / a, v = (-dx * sin + dy * cos) / b;
            const f = Math.pow(Math.pow(Math.abs(u), power) + Math.pow(Math.abs(v), power), 1 / power);
            const cover = Math.min(1, Math.max(0, (1 - f) * Math.min(a, b) + 0.5)) * alpha;
            if (cover <= 0) {
                continue;
            }
            const rim = f > 0.62 ? 0.66 : 1; // a darker edge, so pale pieces stand out on his beige
            const at = (y * dst.width + x) * 4, under = dst.data[at + 3] / 255, out = cover + under * (1 - cover);
            for (let c = 0; c < 3; c++) {
                dst.data[at + c] = Math.round((colour[c] * rim * cover + dst.data[at + c] * under * (1 - cover)) / out);
            }
            dst.data[at + 3] = Math.round(out * 255);
        }
    }
}
/** Cloud silhouettes: circles as [back, up, radius] in world pixels from the puff's origin, `back` pointing behind him. */
const CLOUDS = [
    [[0, 0, 1.0], [0.95, -0.25, 0.85], [1.85, 0.05, 0.62], [0.5, -0.8, 0.62]],
    [[0, 0, 0.9], [0.8, -0.55, 1.0], [1.75, -0.2, 0.72], [2.35, 0.1, 0.46]],
    [[0, 0, 0.8], [0.75, 0.05, 0.92], [1.45, -0.65, 0.82], [2.15, -0.1, 0.55], [0.3, -0.95, 0.5]]
];
const cloudShape = (effect) => CLOUDS[Math.min(2, Math.round(effect.strength * 2))];
/** Puffs up quickly, holds, then shrinks away (cartoon style): 0 at both ends, 1 at its fullest. */
const cloudSize = (age) => age < 0.25 ? age / 0.25 : Math.max(0, 1 - Math.pow((age - 0.25) / 0.75, 1.4));
/** How opaque a puff is: fully while it swells, then fading out as it shrinks (so it decays in time, not just in size). */
const dustAlpha = (age) => age < 0.3 ? 1 : Math.max(0, 1 - Math.pow((age - 0.3) / 0.7, 1.3));
/**
 * A flat white cartoon puff: overlapping hard-edged circles, no feathering. The circles are drawn into one mask first and
 * the mask is blended with the puff's opacity as a whole, so the fade does not show the circles' overlaps as darker blotches.
 */
function dust(dst, effect) {
    const size = cloudSize(effect.age), dir = effect.dir ?? 1, alpha = dustAlpha(effect.age);
    if (size <= 0.04 || alpha <= 0.02) {
        return;
    }
    const drift = 0.9 * effect.age;
    const circles = cloudShape(effect).map(([back, up, radius]) => ({
        x: (effect.x - dir * (back * size + drift)) * PX, y: (effect.y + up * size - 0.2) * PX, r: radius * size * 1.25 * PX
    }));
    const x0 = Math.max(0, Math.floor(Math.min(...circles.map((c) => c.x - c.r)))), x1 = Math.min(dst.width - 1, Math.ceil(Math.max(...circles.map((c) => c.x + c.r))));
    const y0 = Math.max(0, Math.floor(Math.min(...circles.map((c) => c.y - c.r)))), y1 = Math.min(dst.height - 1, Math.ceil(Math.max(...circles.map((c) => c.y + c.r))));
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            if (!circles.some((c) => Math.hypot(x - c.x, y - c.y) <= c.r)) {
                continue;
            }
            const at = (y * dst.width + x) * 4, under = dst.data[at + 3] / 255, out = alpha + under * (1 - alpha);
            for (let ch = 0; ch < 3; ch++) {
                dst.data[at + ch] = Math.round((DUST_COLOR[ch] * alpha + dst.data[at + ch] * under * (1 - alpha)) / out);
            }
            dst.data[at + 3] = Math.round(out * 255);
        }
    }
}
export class KuriScene {
    rasters = new Map();
    files;
    constructor(files) { this.files = files; }
    /** A sprite by name (`walk-0`, `can-3`, `item-wine-9`), a view into its atlas. */
    sprite(name) {
        let raster = this.rasters.get(name);
        if (raster) {
            return raster;
        }
        const entry = ATLAS[name] ?? ATLAS["open-0"];
        const [file, offset, width, height] = entry;
        raster = { width, height, data: this.files[file].subarray(offset, offset + width * height * 4) };
        this.rasters.set(name, raster);
        return raster;
    }
    /** The sixteen rotations of a can ("can") or of a dropped item. */
    spriteFor(kind, angle) {
        const index = canFrameIndex(angle);
        return this.sprite(usesCanSprites(kind) ? `can-${index}` : `item-${kind}-${index}`);
    }
    /** The scene as raw RGBA, PX image pixels per world pixel. */
    rgba(input) {
        const canvas = { width: input.cols * PX, height: SCENE_HEIGHT * PX, data: new Uint8Array(input.cols * PX * SCENE_HEIGHT * PX * 4) };
        // Dust sits on the floor behind everything else, so the planted foot stays crisp in front of its own puff.
        for (const effect of input.effects) {
            if (effect.kind === "dust") {
                dust(canvas, effect);
            }
        }
        // what has landed lies on the floor behind him
        for (const effect of input.effects) {
            if (effect.kind === "bit" && hasLanded(effect)) {
                bit(canvas, effect);
            }
        }
        const pet = this.sprite(input.petFrame);
        blit(canvas, pet, Math.round(frameLeft(input.petX, pet.width / PX, input.cols) * PX), Math.round((BOB[input.petFrame] ?? 0) * PX), input.mirrored);
        for (const can of input.cans) {
            blit(canvas, this.spriteFor(can.kind, can.angle), Math.round((can.x - CAN_WORLD / 2) * PX), Math.round((can.y - CAN_WORLD / 2) * PX));
        }
        for (const effect of input.effects) {
            if (effect.kind === "bit") {
                if (!hasLanded(effect)) {
                    bit(canvas, effect);
                }
            }
            else if (effect.kind !== "dust") {
                spark(canvas, effect);
            }
        }
        return canvas;
    }
}
