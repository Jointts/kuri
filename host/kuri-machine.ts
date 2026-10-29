/**
 * Kurimanju's behaviour as a pure state machine: no timers, no I/O, an injected clock. Callers feed it events and
 * ask which frame to show and when to look again, so every sequence is cancellable by replacing the state and
 * there is nowhere for competing timers to live.
 *
 *   idle ──work-start──▶ walking ──thinking-done──▶ beer ──▶ walking
 *    │  ▲                   │  ▲                               (or idle if work already ended)
 *    │  └──── work-end ─────┘  └────── waking ◀── asleep ◀── collapsing ◀── hangover ◀── idle (after 30s)
 *    └──error──▶ error ──▶ walking | idle                               (45s)
 *
 * While he is walking but standing still (the walker's pauses) he eats or drinks a snack, and what is left of it is
 * dropped when he sets off again. Frame names match src/assets/kuri/<name>.png (see scripts/build-kuri-frames.py).
 */
export type KuriKind = "idle" | "walking" | "beer" | "haaaa" | "hangover" | "collapsing" | "asleep" | "waking" | "error";
export type KuriEvent = "work-start" | "work-end" | "thinking-done" | "response-done" | "activity" | "error";

export interface KuriTimings {
  /** Idle time before the upright hangover. */
  hangoverAfterMs: number;
  /** Further idle time (after the hangover began) before he collapses and sleeps. */
  sleepAfterMs: number;
  /** Minimum gap between beer celebrations, so a run of thinking blocks cannot stack them. */
  beerCooldownMs: number;
}
export const DEFAULT_TIMINGS: Readonly<KuriTimings> = { hangoverAfterMs: 30_000, sleepAfterMs: 15_000, beerCooldownMs: 30_000 };

export type Snack = "pizza" | "taco" | "beer" | "lime" | "wine";
type Colour = readonly [number, number, number];

interface Step { frame: string; ms: number }
const total = (steps: readonly Step[]) => steps.reduce((sum, step) => sum + step.ms, 0);

/** The HAAAA pose with its three-beat bounce, held for at least the length of the sound (1.32 s) plus a little slack. */
export const HAAAA_STEPS: readonly Step[] = [
  { frame: "haaaa-1", ms: 110 }, { frame: "haaaa-0", ms: 110 }, { frame: "haaaa-1", ms: 110 }, { frame: "haaaa-0", ms: 1010 }
];
/**
 * Neutral with the can, drink (a glint on the last third), HAAAA, then the throw: a crouching wind-up still holding
 * the can, and the swing through with an empty hand. The sound starts the instant HAAAA appears, and the can is only
 * thrown once the HAAAA (and so the sound) is over.
 */
export const BEER_STEPS: readonly Step[] = [
  { frame: "beer-neutral", ms: 350 },
  { frame: "beer-drink-0", ms: 600 }, { frame: "beer-drink-1", ms: 300 },
  ...HAAAA_STEPS,
  { frame: "throw-wind", ms: 220 }, { frame: "throw-release", ms: 240 }
];
/** When, into the sequence, the can is released: the start of the swing-through step. */
export const THROW_AT_MS = total(BEER_STEPS) - 240;
/** When, into the sequence, the HAAAA pose appears and the sound must start. */
export const HAAAA_AT_MS = 350 + 600 + 300;
/**
 * What he does with each snack while he stands still: a looping hold-and-bite (or hold-and-sip). `spray` lists the
 * frames that throw bits or drops out of his mouth the moment they appear, `bits` their colours, and `leftover` what
 * he drops afterwards (a physics body: the beer can, or one of the item sprites).
 */
export interface SnackSpec { steps: readonly Step[]; spray: readonly string[]; bits: readonly Colour[]; liquid: boolean; leftover: string }
export const SNACK_SPECS: Readonly<Record<Snack, SnackSpec>> = {
  pizza: {
    steps: [{ frame: "eat-pizza-0", ms: 260 }, { frame: "eat-pizza-1", ms: 160 }], spray: ["eat-pizza-1"], liquid: false, leftover: "crust",
    bits: [[250, 214, 110], [226, 72, 52], [222, 168, 104], [250, 236, 170]]
  },
  taco: {
    steps: [{ frame: "eat-taco-0", ms: 260 }, { frame: "eat-taco-1", ms: 160 }], spray: ["eat-taco-1"], liquid: false, leftover: "shell",
    bits: [[112, 190, 62], [226, 62, 50], [112, 64, 42], [246, 226, 178]]
  },
  beer: {
    steps: [{ frame: "beer-neutral", ms: 240 }, { frame: "beer-drink-0", ms: 520 }, { frame: "beer-drink-1", ms: 160 }], spray: ["beer-drink-0"], liquid: true, leftover: "beer",
    bits: [[246, 192, 62], [250, 224, 120], [255, 250, 232]]
  },
  lime: {
    steps: [{ frame: "drink-lime-0", ms: 240 }, { frame: "drink-lime-1", ms: 620 }], spray: ["drink-lime-1"], liquid: true, leftover: "lime",
    bits: [[168, 78, 44], [200, 110, 52]]
  },
  wine: {
    steps: [{ frame: "drink-wine-0", ms: 240 }, { frame: "drink-wine-1", ms: 620 }], spray: ["drink-wine-1"], liquid: true, leftover: "wine",
    bits: [[142, 28, 54], [172, 44, 70]]
  }
};
/** Pizza and taco are each a third of the time; the other third is one of the three drinks. */
const DRINKS: readonly Snack[] = ["beer", "lime", "wine"];
const SNACK_ORDER: readonly Snack[] = ["pizza", "taco", "beer", "lime", "wine"];

/** Surprise (spikes jitter), then upright neutral without the can. */
export const WAKE_STEPS: readonly Step[] = [{ frame: "wake-0", ms: 325 }, { frame: "wake-1", ms: 325 }, { frame: "open-0", ms: 400 }];
/** A fast shake, then back to normal. */
export const ERROR_STEPS: readonly Step[] = Array.from({ length: 8 }, (_, i) => ({ frame: `error-${i % 2}`, ms: 90 }));
/** A harder wobble just before he falls. */
export const COLLAPSE_STEPS: readonly Step[] = Array.from({ length: 5 }, (_, i) => ({ frame: `hangover-${3 + (i % 2)}`, ms: 140 }));

export const WALK_FRAME_MS = 105;
export const WALK_FRAMES = 8;
export const HANGOVER_WOBBLE = [0, 1, 0, 2] as const;
export const HANGOVER_STEP_MS = 450;
export const SLEEP_STEP_MS = 900;
export const BREATH_STEPS = [0, 1, 2, 1] as const;
export const BREATH_MS = 800;
export const BLINK_MS = 150;
const BLINK_MIN_GAP_MS = 3000;
const BLINK_MAX_GAP_MS = 6500;
const MIN_WAIT_MS = 16;

const SEQUENCES: Partial<Record<KuriKind, readonly Step[]>> = { beer: BEER_STEPS, haaaa: HAAAA_STEPS, waking: WAKE_STEPS, error: ERROR_STEPS, collapsing: COLLAPSE_STEPS };

/** The step playing `elapsed` ms into a sequence, and how long until it ends; undefined once the sequence is over. */
export function stepAt(steps: readonly Step[], elapsed: number): { frame: string; endsIn: number } | undefined {
  let start = 0;
  for (const step of steps) {
    if (elapsed < start + step.ms) return { frame: step.frame, endsIn: start + step.ms - elapsed };
    start += step.ms;
  }
  return undefined;
}

export class KuriMachine {
  private current: { kind: KuriKind; since: number };
  private isWorking = false;
  private lastActivity: number;
  private lastBeer = -Infinity;
  private nextBlink: number;
  private timings: KuriTimings;
  private readonly random: () => number;
  private readonly thinkingBeer: boolean;
  private walkingNow = true;
  private room = { left: true, right: true };
  private facing: 1 | -1 = 1;
  private beerThrown = false;
  private snacking: { kind: Snack; since: number } | undefined;
  private lastSnack: Snack | undefined;
  private requestedSnack: Snack | undefined;
  private leftovers: string[] = [];
  private soundFired = false;
  private sounds = 0;
  private throws: (1 | -1)[] = [];

  constructor(now = Date.now(), options: { random?: () => number; timings?: Partial<KuriTimings>; thinkingBeer?: boolean } = {}) {
    this.random = options.random ?? Math.random;
    this.thinkingBeer = options.thinkingBeer ?? false;
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.current = { kind: "idle", since: now };
    this.lastActivity = now;
    this.nextBlink = now + this.blinkGap();
  }

  get kind(): KuriKind { return this.current.kind; }
  get working(): boolean { return this.isWorking; }
  get thresholds(): Readonly<KuriTimings> { return this.timings; }
  setTimings(timings: Partial<KuriTimings>): void { this.timings = { ...this.timings, ...timings }; }

  private blinkGap(): number { return BLINK_MIN_GAP_MS + Math.floor(this.random() * (BLINK_MAX_GAP_MS - BLINK_MIN_GAP_MS)); }
  private enter(kind: KuriKind, since: number): void {
    this.endSnack();
    this.current = { kind, since };
    // Each celebration is thrown from a randomly chosen side; the pet is mirrored for the whole sequence.
    if (kind === "beer") { this.facing = this.pickFacing(); this.beerThrown = false; }
    if (kind === "beer" || kind === "haaaa") this.soundFired = false;
  }
  /**
   * Whether he is actually walking right now. While the walking state is on but he is pausing, he stands upright and
   * breathes instead of walking in place. The walker (in the physics world) is the authority; the controller reports it.
   */
  setMoving(moving: boolean, now = Date.now()): void {
    if (moving) this.endSnack();
    else if (this.walkingNow && this.current.kind === "walking" && !this.snacking) this.startSnack(now);
    this.walkingNow = moving;
  }

  /** The snack he is eating or drinking right now (only while he stands still during a walk). */
  get snack(): Snack | undefined { return this.snacking?.kind; }
  /** Make his next snack this one (the demo and previews); otherwise it is random. */
  queueSnack(kind: Snack): void { this.requestedSnack = kind; }
  /** What he has finished and must drop since the last call: "beer" (the empty can), "crust", "shell", "lime" or "wine". */
  takeLeftovers(): string[] {
    const out = this.leftovers;
    this.leftovers = [];
    return out;
  }
  private pickSnack(): Snack {
    const wanted = this.requestedSnack;
    this.requestedSnack = undefined;
    if (wanted) return wanted;
    const roll = this.random() * 3, slot = Math.floor(roll);
    let kind: Snack = slot === 0 ? "pizza" : slot === 1 ? "taco" : DRINKS[Math.min(2, Math.floor((roll - slot) * 3))]!;
    // Never the same snack twice running.
    if (kind === this.lastSnack) kind = SNACK_ORDER[(SNACK_ORDER.indexOf(kind) + 1) % SNACK_ORDER.length]!;
    return kind;
  }
  private startSnack(now: number): void {
    const kind = this.pickSnack();
    this.snacking = { kind, since: now };
    this.lastSnack = kind;
  }
  /** He is done (set off again, or something interrupted him): whatever is left falls to the floor. */
  private endSnack(): void {
    if (!this.snacking) return;
    this.leftovers.push(SNACK_SPECS[this.snacking.kind].leftover);
    this.snacking = undefined;
  }
  private snackStep(now: number): { frame: string; endsIn: number } | undefined {
    if (!this.snacking) return undefined;
    const steps = SNACK_SPECS[this.snacking.kind].steps;
    return stepAt(steps, Math.max(0, now - this.snacking.since) % total(steps));
  }
  /** Which sides have room to throw toward from where he stands (he never throws into a wall he is standing beside). */
  setRoom(left: boolean, right: boolean): void { this.room = { left, right }; }
  private pickFacing(): 1 | -1 {
    if (this.room.right && !this.room.left) return 1;
    if (this.room.left && !this.room.right) return -1;
    return this.random() < 0.5 ? 1 : -1;
  }
  get moving(): boolean { return this.walkingNow; }
  /** True while the pet should be drawn mirrored (a left-handed celebration). */
  get mirrored(): boolean { return this.current.kind === "beer" && this.facing === -1; }

  /** HAAAA sounds due since the last call: one the instant the HAAAA pose appears, never more than one per celebration. */
  takeSounds(now = Date.now()): number {
    this.tick(now);
    const out = this.sounds;
    this.sounds = 0;
    return out;
  }

  /** `/kurimanju-haaaa`: only the HAAAA pose and sound, at his current spot, with no can. False if he is busy. */
  previewHaaaa(now = Date.now()): boolean {
    this.tick(now);
    if (this.current.kind !== "idle" && this.current.kind !== "walking") return false;
    this.lastActivity = now;
    this.enter("haaaa", now);
    return true;
  }

  /** Cans released since the last call, each with the side it was thrown toward (+1 right, -1 left). */
  takeThrows(now = Date.now()): (1 | -1)[] {
    this.tick(now);
    const out = this.throws;
    this.throws = [];
    return out;
  }
  private resting(): KuriKind { return this.isWorking ? "walking" : "idle"; }

  /** Why a thinking-done at `now` would not start the beer (undefined when it would). For diagnostics. */
  beerBlockedBy(now = Date.now()): string | undefined {
    this.tick(now);
    if (!this.thinkingBeer) return "thinking does not trigger the beer (it follows a completed response)";
    if (!this.isWorking) return "no run in progress";
    if (this.current.kind !== "walking") return `busy: ${this.current.kind}`;
    const wait = this.timings.beerCooldownMs - (now - this.lastBeer);
    return wait > 0 ? `cooldown, ${Math.ceil(wait / 1000)}s left` : undefined;
  }

  /** Activity ends sleep and hangover; sequences already playing finish first and then pick walking or idle. */
  private wake(now: number): void {
    switch (this.current.kind) {
      case "asleep": this.enter("waking", now); break;
      case "collapsing": case "hangover": this.enter(this.resting(), now); break;
      case "idle": if (this.isWorking) this.enter("walking", now); break;
      default: break;
    }
  }

  dispatch(event: KuriEvent, now = Date.now()): void {
    this.tick(now);
    this.lastActivity = now;
    switch (event) {
      case "work-start": {
        const fresh = !this.isWorking;
        this.isWorking = true;
        // A new request cuts a celebration short: the can (if not yet thrown) goes now, and he gets back to work.
        if (fresh && (this.current.kind === "beer" || this.current.kind === "haaaa")) {
          if (this.current.kind === "beer" && !this.beerThrown) { this.beerThrown = true; this.throws.push(this.facing); }
          this.enter("walking", now);
        } else this.wake(now);
        break;
      }
      case "activity": this.wake(now); break;
      case "work-end":
        this.isWorking = false;
        if (this.current.kind === "walking") this.enter("idle", now);
        break;
      case "response-done":
        // One can per completed response. If a celebration is already playing (or he is still waking), the can is
        // simply thrown now instead of queueing a second celebration.
        this.wake(now);
        if (this.current.kind === "idle" || this.current.kind === "walking") this.enter("beer", now);
        else this.throws.push(this.pickFacing());
        break;
      case "thinking-done":
        // Opt-in alternative trigger. Only while working and walking, never mid-sequence, never within the cooldown.
        if (this.thinkingBeer && this.isWorking && this.current.kind === "walking" && now - this.lastBeer >= this.timings.beerCooldownMs) {
          this.lastBeer = now;
          this.enter("beer", now);
        }
        break;
      case "error":
        // A sleeper wakes first and finishes waking; otherwise the shake interrupts whatever was playing.
        this.wake(now);
        if (this.current.kind === "idle" || this.current.kind === "walking" || this.current.kind === "beer") this.enter("error", now);
        break;
    }
  }

  /** Move to a state directly (the demo): thresholds and sequences then continue from there as usual. */
  force(kind: KuriKind, now = Date.now(), working = kind === "walking"): void {
    this.isWorking = working;
    // Hangover/collapse/sleep imply the idle time that leads to them; every other state means "just active".
    const idleSince = kind === "hangover" ? this.timings.hangoverAfterMs : kind === "collapsing" || kind === "asleep" ? this.timings.hangoverAfterMs + this.timings.sleepAfterMs : 0;
    this.lastActivity = now - idleSince;
    this.enter(kind, now);
    if (kind === "idle") this.nextBlink = now + this.blinkGap();
  }

  /** Apply every time-based transition due by `now` (several can be due after a long pause, e.g. a sleeping laptop). */
  private tick(now: number): void {
    for (let guard = 0; guard < 12; guard++) {
      const { kind, since } = this.current;
      const idleFor = now - this.lastActivity;
      const sleepAt = this.lastActivity + this.timings.hangoverAfterMs + this.timings.sleepAfterMs;
      if (kind === "idle") {
        if (this.isWorking) { this.enter("walking", now); continue; }
        if (idleFor >= this.timings.hangoverAfterMs) { this.enter("hangover", this.lastActivity + this.timings.hangoverAfterMs); continue; }
      } else if (kind === "walking") {
        if (!this.isWorking) { this.enter("idle", now); continue; }
      } else if (kind === "hangover") {
        if (now >= sleepAt) { this.enter("collapsing", sleepAt); continue; }
      } else if (kind === "asleep") {
        return;
      } else {
        const steps = SEQUENCES[kind]!;
        const length = total(steps);
        if ((kind === "beer" || kind === "haaaa") && !this.soundFired && now - since >= (kind === "beer" ? HAAAA_AT_MS : 0)) { this.soundFired = true; this.sounds++; }
        if (kind === "beer" && !this.beerThrown && now - since >= THROW_AT_MS) { this.beerThrown = true; this.throws.push(this.facing); }
        if (now - since >= length) {
          this.enter(kind === "collapsing" ? "asleep" : this.resting(), since + length);
          if (this.current.kind === "idle") this.nextBlink = this.current.since + this.blinkGap();
          continue;
        }
      }
      return;
    }
  }

  /** The frame to show at `now` (also applies due transitions and advances the blink schedule). */
  frame(now = Date.now()): string {
    this.tick(now);
    const { kind, since } = this.current;
    const elapsed = Math.max(0, now - since);
    switch (kind) {
      case "idle": {
        if (now >= this.nextBlink + BLINK_MS) this.nextBlink = now + this.blinkGap();
        const level = BREATH_STEPS[Math.floor(elapsed / BREATH_MS) % BREATH_STEPS.length]!;
        return `${now >= this.nextBlink && now < this.nextBlink + BLINK_MS ? "closed" : "open"}-${level}`;
      }
      case "walking":
        if (!this.walkingNow) return this.snackStep(now)?.frame ?? `open-${BREATH_STEPS[Math.floor(elapsed / BREATH_MS) % BREATH_STEPS.length]}`;
        return `walk-${Math.floor(elapsed / WALK_FRAME_MS) % WALK_FRAMES}`;
      case "hangover": return `hangover-${HANGOVER_WOBBLE[Math.floor(elapsed / HANGOVER_STEP_MS) % HANGOVER_WOBBLE.length]}`;
      case "asleep": { const i = Math.floor(elapsed / SLEEP_STEP_MS); return `asleep-${i % 2}-${i % 3}`; }
      default: return stepAt(SEQUENCES[kind]!, elapsed)?.frame ?? "open-0";
    }
  }

  /** Milliseconds until the frame or state can next change, so callers wait on exact deadlines instead of polling. */
  nextChangeIn(now = Date.now()): number {
    this.tick(now);
    const { kind, since } = this.current;
    const elapsed = Math.max(0, now - since);
    const untilBoundary = (period: number) => period - (elapsed % period);
    const sleepAt = this.lastActivity + this.timings.hangoverAfterMs + this.timings.sleepAfterMs;
    let wait: number;
    switch (kind) {
      case "idle": {
        const blink = now < this.nextBlink ? this.nextBlink - now : now < this.nextBlink + BLINK_MS ? this.nextBlink + BLINK_MS - now : Infinity;
        const hangover = this.isWorking ? Infinity : this.lastActivity + this.timings.hangoverAfterMs - now;
        wait = Math.min(untilBoundary(BREATH_MS), blink, hangover);
        break;
      }
      case "walking": wait = this.walkingNow ? untilBoundary(WALK_FRAME_MS) : this.snackStep(now)?.endsIn ?? untilBoundary(BREATH_MS); break;
      case "hangover": wait = Math.min(untilBoundary(HANGOVER_STEP_MS), sleepAt - now); break;
      case "asleep": wait = untilBoundary(SLEEP_STEP_MS); break;
      default: wait = stepAt(SEQUENCES[kind]!, elapsed)?.endsIn ?? MIN_WAIT_MS;
    }
    return Math.max(MIN_WAIT_MS, wait);
  }
}
