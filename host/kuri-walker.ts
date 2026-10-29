/**
 * Kurimanju's wandering: which way he faces, when he walks, pauses and turns around. Pure and deterministic given
 * its random source. It runs inside the physics step (fixed 120 Hz), so his motion depends on elapsed time and never
 * on how often the terminal repaints, and the physics engine always knows his exact position and velocity.
 *
 * World units are the physics engine's: one unit is one terminal column, speeds are columns per second.
 */
export interface WalkerConfig {
  /** Walking speed is picked from this range (columns per second) each time he sets off. */
  minSpeed: number;
  maxSpeed: number;
  /** Pauses last between these many seconds. */
  pauseMinS: number;
  pauseMaxS: number;
  /** Between decisions (pause / turn / keep going) he walks this many seconds. */
  decideMinS: number;
  decideMaxS: number;
  /** He turns round when his sprite edge is this close to a wall. */
  turnMargin: number;
}
export const DEFAULT_WALKER: Readonly<WalkerConfig> = {
  minSpeed: 3, maxSpeed: 6, pauseMinS: 1.2, pauseMaxS: 2.6, decideMinS: 1.4, decideMaxS: 3.8, turnMargin: 1.5
};

export class KuriWalker {
  /** +1 faces and walks right, -1 left. */
  dir: 1 | -1 = 1;
  private on = false;
  private pausing = false;
  private speed: number;
  private timeLeft: number;
  private readonly random: () => number;
  private config: WalkerConfig;

  constructor(random: () => number = Math.random, config: Partial<WalkerConfig> = {}) {
    this.random = random;
    this.config = { ...DEFAULT_WALKER, ...config };
    this.speed = this.pickSpeed();
    this.timeLeft = this.nextDecision();
  }

  setConfig(config: Partial<WalkerConfig>): void { this.config = { ...this.config, ...config }; }
  get settings(): Readonly<WalkerConfig> { return this.config; }

  private uniform(min: number, max: number): number { return min + (max - min) * this.random(); }
  private pickSpeed(): number { return this.uniform(this.config.minSpeed, Math.max(this.config.minSpeed, this.config.maxSpeed)); }
  private nextDecision(): number { return this.uniform(this.config.decideMinS, this.config.decideMaxS); }

  /** Whether he is allowed to move at all (only while the pet is in its walking state). */
  get enabled(): boolean { return this.on; }
  setEnabled(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    // Setting off again after any stop (beer, sleep, ...) starts a fresh walk from where he stands.
    if (on) { this.pausing = false; this.speed = this.pickSpeed(); this.timeLeft = this.nextDecision(); }
  }

  /** True while he is actually walking (enabled and not in a pause). */
  get moving(): boolean { return this.on && !this.pausing; }
  /** Signed velocity, columns per second (0 when standing). */
  get velocity(): number { return this.moving ? this.dir * this.speed : 0; }
  /** Milliseconds until his next decision, so a timer can wake exactly when the walk/pause frame must change. */
  get nextDecisionMs(): number { return Math.max(0, this.timeLeft * 1000); }

  /**
   * Advance `dt` seconds from centre position `x`, keeping the sprite (half width `half`) between 0 and `width`.
   * Cans in his way do not matter to him: the physics kicks them aside while he keeps walking. Returns the new x.
   */
  step(dt: number, x: number, width: number, half: number): number {
    if (!this.on) return x;
    const min = half, max = width - half;
    this.timeLeft -= dt;
    if (this.pausing) {
      if (this.timeLeft <= 0) {
        this.pausing = false;
        this.speed = this.pickSpeed();
        if (this.random() < 0.4) this.dir = this.dir === 1 ? -1 : 1;
        this.timeLeft = this.nextDecision();
      }
      return Math.min(max, Math.max(min, x));
    }
    // Turn round before the sprite touches a wall.
    const margin = this.config.turnMargin;
    if ((this.dir === 1 && x >= max - margin) || (this.dir === -1 && x <= min + margin)) this.dir = this.dir === 1 ? -1 : 1;
    if (this.timeLeft <= 0) {
      const roll = this.random();
      if (roll < 0.35) { this.pause(this.uniform(this.config.pauseMinS, this.config.pauseMaxS)); return x; }
      if (roll < 0.65) this.dir = this.dir === 1 ? -1 : 1;
      this.timeLeft = this.nextDecision();
    }
    return Math.min(max, Math.max(min, x + this.dir * this.speed * dt));
  }

  /** Stand still for `seconds` right now (the demo's snack stops). Only while he is allowed to walk. */
  rest(seconds: number): void { if (this.on) this.pause(seconds); }

  private pause(seconds: number): void {
    this.pausing = true;
    this.timeLeft = seconds;
  }
}
