import { KuriMachine, SNACK_SPECS } from "./kuri-machine.js";
import { FLOOR_Y, KuriPhysics } from "./kuri-physics.js";
import { BIT_FADE_S } from "./kuri-scene.js";
/** While cans move the scene repaints at this interval (~20 fps). */
export const SCENE_FRAME_MS = 40;
/** While he only walks, ~10 fps is smooth enough: the position moves a fraction of a column per repaint. */
export const WALK_FRAME_MS = 50;
/** Dust alone repaints a little slower than sparks and flying cans (~12 fps): it is soft and slow. */
export const DUST_FRAME_MS = 50;
const EFFECT_MS = 180;
/** A step's puff of dust lasts a little longer than a spark. */
const DUST_MS = 420;
const MAX_EFFECTS = 220; // particles that rest on the floor count too
/** How long a particle lies on the floor before it fades, in seconds (each picks its own). */
const REST_MIN_S = 2.5, REST_MAX_S = 5;
/** Where his mouth is in the scene (world px), and how many bits one bite or sip throws. */
const MOUTH_Y = 6.4;
/** Where his mouth is while he drinks (the head is turned and a little higher than at rest): world px, left of his centre. */
const SIP_MOUTH_DX = -0.7;
const SIP_MOUTH_Y = 5.8;
const BITS_PER_BITE = 7;
/** Walk frames where a foot has just landed (the contact poses): the other, back foot is planted behind him. */
const STEP_FRAMES = new Set(["walk-0", "walk-4"]);
/** How far behind his centre the back foot is planted; the cartoon puff pops up there, never at the front foot. */
const FOOT_BEHIND = 2.45;
/** An impact has to be at least this hard (closing speed, px/s) to flash. */
const FLASH_SPEED = 12;
/** Every sequence once, each held long enough to read. Sequences that end themselves are held until they would. */
export const DEMO_STEPS = [
    { kind: "idle", label: "idle · breathing and blinking", holdMs: 4000 },
    { kind: "walking", label: "walking (Claude is working)", holdMs: 3400, working: true },
    { kind: "beer", label: "response complete · beer → drinking → HAAAA (sound) → throw", holdMs: 3200, working: true },
    { kind: "walking", label: "pause · pizza, crumbs flying, crust dropped", holdMs: 2600, working: true, snack: "pizza" },
    { kind: "walking", label: "pause · taco", holdMs: 2600, working: true, snack: "taco" },
    { kind: "walking", label: "pause · beer, can dropped", holdMs: 2600, working: true, snack: "beer" },
    { kind: "walking", label: "pause · the lime drink", holdMs: 2600, working: true, snack: "lime" },
    { kind: "walking", label: "pause · wine", holdMs: 2600, working: true, snack: "wine" },
    { kind: "hangover", label: "idle 30s · upright hangover", holdMs: 4200 },
    { kind: "collapsing", label: "idle 45s · wobble and collapse", holdMs: 700 },
    { kind: "asleep", label: "sleeping · z's and breathing", holdMs: 6000 },
    { kind: "waking", label: "activity · surprise → neutral", holdMs: 1050 },
    { kind: "idle", label: "idle again", holdMs: 1500 },
    { kind: "error", label: "error · shake and recover", holdMs: 800 }
];
/**
 * Owns the machine, the can physics and exactly one timer. The timer waits for the earliest of the machine's next
 * possible change, the next demo step, and (only while cans are moving or sparks are fading) the next scene frame.
 * The UI is asked to repaint only when something visible changed. Events, the demo and disposal all go through
 * here, so nothing else can leave a timer running. Physics is independent of the pet's state: a can keeps flying
 * after he has gone back to idle.
 */
export class KuriController {
    machine;
    physics;
    effects = [];
    lastWalkFrame = "";
    lastSnackFrame = "";
    random;
    steps = 0;
    dirty = false;
    repaint;
    onSound;
    onSoundStop;
    clock;
    cancelTimer;
    timer;
    shown = "";
    disposed = false;
    demo;
    lastWorking = false;
    constructor(repaint, options) {
        this.timer = options.timer;
        this.clock = options.now ?? Date.now;
        this.random = options.random ?? Math.random;
        this.repaint = repaint;
        this.onSound = options.onSound;
        this.onSoundStop = options.onSoundStop;
        this.machine = new KuriMachine(this.clock(), {
            ...(options.random ? { random: options.random } : {}), ...(options.timings ? { timings: options.timings } : {}),
            ...(options.thinkingBeer !== undefined ? { thinkingBeer: options.thinkingBeer } : {})
        });
        this.physics = new KuriPhysics({
            width: options.sceneWidth ?? 45, ...(options.maxCans !== undefined ? { maxCans: options.maxCans } : {}),
            ...(options.random ? { random: options.random } : {}), ...(options.physics ? { config: options.physics } : {}),
            ...(options.walker ? { walker: options.walker } : {}), ...(options.bodyX !== undefined ? { bodyX: options.bodyX } : {})
        });
        this.schedule();
    }
    /** Everything the renderer needs for the current moment. Effect ages are computed here, not stored. */
    snapshot() {
        const now = this.clock();
        const walker = this.physics.walker;
        return {
            petX: this.physics.centerX, petFrame: this.frame(),
            // A left-handed throw mirrors the celebration; walking left mirrors the (right-facing) profile frames.
            mirrored: this.machine.mirrored || (this.machine.kind === "walking" && walker.moving && walker.dir === -1),
            cans: this.physics.cans.map(({ x, y, angle, kind }) => ({ x, y, angle, kind })),
            effects: this.effects.map(({ at, life, ...effect }) => ({ ...effect, age: Math.min(1, (now - at) / life) }))
        };
    }
    /** Tell the machine which sides he has room to throw toward, from where he stands right now. */
    syncRoom() { this.machine.setRoom(this.physics.roomFor(-1), this.physics.roomFor(1)); }
    /** The widget reports its width here; walls move and cans are pulled back inside if the terminal shrank. */
    resize(cols) { this.physics.resize(cols); }
    /** A can thrown right now, without the celebration (the `/kurimanju-throw` test command). */
    throwCan(facing = Math.random() < 0.5 ? 1 : -1) {
        if (this.disposed)
            return;
        this.physics.spawn(facing);
        this.refresh();
    }
    /** `/kurimanju-haaaa`: the HAAAA pose and sound at his current spot, with no can and no real completion. */
    previewHaaaa() {
        if (this.disposed)
            return false;
        this.syncRoom();
        const accepted = this.machine.previewHaaaa(this.clock());
        if (accepted)
            this.refresh();
        return accepted;
    }
    /** Remove every can and spark. */
    clearCans() {
        this.physics.clear();
        this.effects = [];
        this.dirty = true;
        this.refresh();
    }
    get demoRunning() { return this.demo !== undefined; }
    /** The frame for the current moment; remembered so the timer only repaints on real changes. */
    frame() {
        this.shown = this.machine.frame(this.clock());
        return this.shown;
    }
    /** A real Claude Code event: it cancels a running demo, applies to the machine, and repaints if the frame changed. */
    dispatch(event) {
        if (this.disposed)
            return;
        if (event === "work-start")
            this.lastWorking = true;
        else if (event === "work-end")
            this.lastWorking = false;
        if (this.demo)
            this.finishDemo();
        this.syncRoom();
        const celebrating = this.machine.kind === "beer" || this.machine.kind === "haaaa";
        this.machine.dispatch(event, this.clock());
        // A new request cut the celebration short: its sound goes with it.
        if (celebrating && this.machine.kind !== "beer" && this.machine.kind !== "haaaa")
            this.onSoundStop?.();
        this.refresh();
    }
    /** Play every sequence once. `onStep` receives each label, then undefined when the demo ends or is cancelled. */
    startDemo(onStep, steps = DEMO_STEPS) {
        if (this.disposed)
            return;
        if (this.demo)
            this.finishDemo();
        this.demo = { index: -1, nextAt: this.clock(), resume: { working: this.machine.working }, onStep, steps };
        this.advanceDemo();
        this.refresh();
    }
    /** Make him stop and have this snack now, for `holdMs`; then he is back to what he was really doing, leftover dropped. */
    eat(snack, holdMs = 8000) {
        this.startDemo(() => { }, [{ kind: "walking", label: `pause · ${snack}`, holdMs, working: true, snack }]);
    }
    /** Make him walk for `holdMs` as if Claude were working (with his usual pauses and snacks); then back to what he really was doing. */
    walkFor(holdMs) {
        this.startDemo(() => { }, [{ kind: "walking", label: "walking", holdMs, working: true }]);
    }
    stopDemo() {
        if (!this.demo)
            return;
        this.finishDemo();
        this.refresh();
    }
    advanceDemo() {
        const demo = this.demo;
        if (!demo)
            return;
        const now = this.clock();
        demo.index++;
        const step = demo.steps[demo.index];
        if (!step) {
            this.finishDemo();
            return;
        }
        this.machine.force(step.kind, now, step.working ?? false);
        // A snack starts when he goes from walking to standing still, so he has to count as walking when the step begins.
        if (step.snack)
            this.machine.setMoving(true, now);
        if (step.snack) {
            // Stand still for most of the step with this snack in hand; the leftover drops when the step ends.
            this.machine.queueSnack(step.snack);
            this.physics.walker.setEnabled(true);
            this.physics.walker.rest((step.holdMs - 200) / 1000);
        }
        demo.nextAt = now + step.holdMs;
        demo.onStep(step.label);
    }
    /** Hand control back to the real state: idle (or walking if a run is in progress) with fresh timers. */
    finishDemo() {
        const demo = this.demo;
        this.demo = undefined;
        if (this.machine.kind === "beer" || this.machine.kind === "haaaa")
            this.onSoundStop?.();
        const now = this.clock();
        this.machine.force(this.lastWorking ? "walking" : "idle", now, this.lastWorking);
        demo?.onStep(undefined);
    }
    /** Advance physics, release any cans the machine threw, then repaint if anything visible changed. */
    refresh() {
        const now = this.clock();
        this.syncRoom();
        // Time since the last update passed under the *old* state: catch the world up first, and only then let the
        // machine move to its new state and switch him on or off. (Otherwise he would retroactively walk through the
        // moments he spent waking up, and appear to jump.)
        this.physics.advance(now);
        const throws = this.machine.takeThrows(now);
        // He only walks while the pet is in its walking state; every other state (beer, sleep, ...) happens where he stands.
        this.physics.walker.setEnabled(this.machine.kind === "walking");
        this.machine.setMoving(this.physics.walker.moving, now);
        for (const facing of throws) {
            this.physics.spawn(facing);
            this.dirty = true;
        }
        // What he finished eating drops behind him, as he sets off.
        for (const kind of this.machine.takeLeftovers()) {
            this.physics.spawn(this.physics.walker.dir === 1 ? -1 : 1, kind, true);
            this.dirty = true;
        }
        this.spraySnack(now);
        // The sound is started here, separately from drawing: once per HAAAA, whatever the terminal does with repaints.
        for (let n = this.machine.takeSounds(now); n > 0; n--)
            this.onSound?.();
        for (const hit of this.physics.takeImpacts()) {
            if (hit.speed >= FLASH_SPEED)
                this.effects.push({ x: hit.x, y: hit.y, age: 0, at: now, life: EFFECT_MS, kind: "spark", strength: Math.min(1, hit.speed / 45) });
        }
        if (this.effects.length > MAX_EFFECTS)
            this.effects = this.effects.slice(-MAX_EFFECTS);
        const effectsBefore = this.effects.length;
        this.stepDust(now);
        this.effects = this.effects.filter((effect) => now - effect.at < effect.life);
        const moving = this.physics.active || this.effects.length > 0;
        const changed = this.machine.frame(now) !== this.shown || moving || this.dirty || effectsBefore !== this.effects.length;
        this.dirty = false;
        if (changed)
            this.repaint();
        this.schedule();
    }
    /** Each bite or sip, the moment its frame appears, flings crumbs (or drops of drink) out of his mouth. */
    spraySnack(now) {
        const snack = this.machine.snack;
        const frame = snack ? this.machine.frame(now) : "";
        if (snack && frame !== this.lastSnackFrame && SNACK_SPECS[snack].spray.includes(frame)) {
            const { bits, liquid } = SNACK_SPECS[snack];
            if (liquid)
                this.sprayDrops(now, bits);
            else
                this.sprayPieces(now, bits);
            this.effects = this.effects.slice(-MAX_EFFECTS);
            this.dirty = true;
        }
        this.lastSnackFrame = snack ? frame : "";
    }
    /**
     * Gives a flying particle its landing: when it reaches the floor (solving its flight under the scene's gravity), a clamp
     * so it lands inside the walls, and a life that covers the flight, a few seconds of lying there and the fade.
     */
    landing(particle, restY) {
        const vx = particle.vx ?? 0, vy = particle.vy ?? 0, g = 60;
        const landS = (-vy + Math.sqrt(vy * vy - 2 * g * (particle.y - restY))) / g;
        const landX = particle.x + vx * landS, width = this.physics.width;
        if (landX < 0.4 || landX > width - 0.4)
            particle.vx = (Math.min(width - 0.4, Math.max(0.4, landX)) - particle.x) / landS;
        particle.landS = landS;
        particle.lifeS = landS + REST_MIN_S + this.random() * (REST_MAX_S - REST_MIN_S) + BIT_FADE_S;
        particle.life = particle.lifeS * 1000;
        particle.y = Math.min(particle.y, restY);
    }
    /**
     * A sip dribbles from the corner of his mouth: a random number of drops, released over a random stretch of time, mostly tiny
     * with a few fat ones, each with its own speed, flight time, stretch and a slight shade of its own, so it looks like liquid
     * and not like a row of identical dots.
     */
    sprayDrops(now, palette) {
        const uniform = (min, max) => min + (max - min) * this.random();
        const count = 5 + Math.floor(this.random() * 7);
        for (let n = 0; n < count; n++) {
            const kind = this.random();
            const fat = kind < 0.2, tiny = kind > 0.55;
            const size = fat ? uniform(0.36, 0.52) : tiny ? uniform(0.1, 0.2) : uniform(0.2, 0.34);
            const shade = uniform(-18, 22); // lighter or darker than the drink, a little
            const base = palette[Math.floor(this.random() * palette.length)];
            const lifeS = uniform(0.4, 0.85);
            const drop = {
                x: this.physics.centerX + SIP_MOUTH_DX + uniform(-0.4, 0.6), y: SIP_MOUTH_Y + uniform(-0.3, 0.5),
                age: 0, at: now + uniform(0, 380), life: lifeS * 1000, lifeS, kind: "bit", strength: 0,
                vx: uniform(-4, 9) * (tiny ? 1.25 : fat ? 0.7 : 1), vy: -uniform(0, 8) * (fat ? 0.7 : 1),
                size, stretch: fat ? 0.7 : uniform(0.7, 1.4),
                color: base.map((v) => Math.max(0, Math.min(255, Math.round(v + shade))))
            };
            this.landing(drop, FLOOR_Y + 0.1 - size * 0.4); // splashed flat on the floor
            this.effects.push(drop);
        }
    }
    /**
     * A bite flings pieces of what he is eating: a random number of them, thrown both ways, each its own kind (a long thin shred of
     * lettuce, a blocky chunk of tomato or pepperoni, a lumpy crumb of crust or meat), size, speed, flight time, spin and shade.
     */
    sprayPieces(now, palette) {
        const uniform = (min, max) => min + (max - min) * this.random();
        const count = 6 + Math.floor(this.random() * 8);
        for (let n = 0; n < count; n++) {
            const base = palette[Math.floor(this.random() * palette.length)];
            const [r, g, b] = base;
            const green = g > r + 25 && g > b + 25, red = r > 200 && g < 110; // lettuce is green; the cream of cheese is not
            const shape = green ? "shred" : red ? "chunk" : this.random() < 0.35 ? "chunk" : "crumb";
            const fat = this.random() < 0.18;
            const size = (shape === "shred" ? uniform(0.16, 0.26) : uniform(0.16, 0.36)) * (fat ? 1.45 : 1);
            const side = this.random() < 0.5 ? 1 : -1;
            const lifeS = uniform(0.45, 0.9);
            const shade = uniform(-16, 18);
            const crumb = {
                x: this.physics.centerX + side * uniform(0, 1.4), y: MOUTH_Y + uniform(-0.2, 0.5), age: 0, at: now + uniform(0, 120), life: lifeS * 1000, lifeS,
                kind: "bit", strength: 0, vx: side * uniform(2, 16), vy: -uniform(4, 18) * (fat ? 0.75 : 1),
                size, shape, angle0: uniform(0, Math.PI * 2), spin: (this.random() < 0.5 ? 1 : -1) * uniform(3, 15), aspect: shape === "shred" ? uniform(1.8, 3.2) : uniform(1, 1.5),
                color: base.map((v) => Math.max(0, Math.min(255, Math.round(v + shade))))
            };
            this.landing(crumb, FLOOR_Y + 0.15 - size * (shape === "shred" ? 0.45 : 0.5)); // lying flat on the floor
            this.effects.push(crumb);
        }
    }
    /** A cartoon puff at the back foot each time a contact pose of the walk begins (every other frame, about twice a second). */
    stepDust(now) {
        const frame = this.machine.kind === "walking" && this.physics.walker.moving ? this.machine.frame(now) : "";
        if (STEP_FRAMES.has(frame) && frame !== this.lastWalkFrame) {
            const dir = this.physics.walker.dir;
            // `strength` carries which of the three cloud shapes this step gets, cycling so no two in a row match.
            this.effects.push({ x: this.physics.centerX - dir * FOOT_BEHIND, y: FLOOR_Y - 0.15, age: 0, at: now, life: DUST_MS, kind: "dust", dir, strength: (this.steps++ % 3) / 2 });
            this.effects = this.effects.slice(-MAX_EFFECTS);
            this.dirty = true;
        }
        this.lastWalkFrame = frame;
    }
    schedule() {
        this.cancelTimer?.();
        this.cancelTimer = undefined;
        if (this.disposed)
            return;
        const now = this.clock();
        let wait = this.machine.nextChangeIn(now);
        if (this.demo)
            wait = Math.min(wait, Math.max(16, this.demo.nextAt - now));
        const walker = this.physics.walker;
        if (walker.enabled) {
            wait = Math.min(wait, Math.max(16, walker.nextDecisionMs)); // the next walk / pause / turn decision
            if (walker.moving)
                wait = Math.min(wait, WALK_FRAME_MS); // smooth motion while he walks
        }
        if (this.physics.cans.some((can) => !can.asleep) || this.effects.some((effect) => effect.kind !== "dust"))
            wait = Math.min(wait, SCENE_FRAME_MS);
        else if (this.effects.length > 0)
            wait = Math.min(wait, DUST_FRAME_MS);
        this.cancelTimer = this.timer(() => {
            this.cancelTimer = undefined;
            if (this.disposed)
                return;
            if (this.demo && this.clock() >= this.demo.nextAt)
                this.advanceDemo();
            this.refresh();
        }, wait);
    }
    dispose() {
        this.disposed = true;
        this.cancelTimer?.();
        this.cancelTimer = undefined;
        this.demo = undefined;
        this.effects = [];
        this.onSoundStop?.();
    }
}
