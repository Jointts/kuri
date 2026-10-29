export const DEFAULT_WALKER = {
    minSpeed: 3, maxSpeed: 6, pauseMinS: 1.2, pauseMaxS: 2.6, decideMinS: 1.4, decideMaxS: 3.8, turnMargin: 1.5
};
export class KuriWalker {
    /** +1 faces and walks right, -1 left. */
    dir = 1;
    on = false;
    pausing = false;
    speed;
    timeLeft;
    random;
    config;
    constructor(random = Math.random, config = {}) {
        this.random = random;
        this.config = { ...DEFAULT_WALKER, ...config };
        this.speed = this.pickSpeed();
        this.timeLeft = this.nextDecision();
    }
    setConfig(config) { this.config = { ...this.config, ...config }; }
    get settings() { return this.config; }
    uniform(min, max) { return min + (max - min) * this.random(); }
    pickSpeed() { return this.uniform(this.config.minSpeed, Math.max(this.config.minSpeed, this.config.maxSpeed)); }
    nextDecision() { return this.uniform(this.config.decideMinS, this.config.decideMaxS); }
    /** Whether he is allowed to move at all (only while the pet is in its walking state). */
    get enabled() { return this.on; }
    setEnabled(on) {
        if (on === this.on)
            return;
        this.on = on;
        // Setting off again after any stop (beer, sleep, ...) starts a fresh walk from where he stands.
        if (on) {
            this.pausing = false;
            this.speed = this.pickSpeed();
            this.timeLeft = this.nextDecision();
        }
    }
    /** True while he is actually walking (enabled and not in a pause). */
    get moving() { return this.on && !this.pausing; }
    /** Signed velocity, columns per second (0 when standing). */
    get velocity() { return this.moving ? this.dir * this.speed : 0; }
    /** Milliseconds until his next decision, so a timer can wake exactly when the walk/pause frame must change. */
    get nextDecisionMs() { return Math.max(0, this.timeLeft * 1000); }
    /**
     * Advance `dt` seconds from centre position `x`, keeping the sprite (half width `half`) between 0 and `width`.
     * Cans in his way do not matter to him: the physics kicks them aside while he keeps walking. Returns the new x.
     */
    step(dt, x, width, half) {
        if (!this.on)
            return x;
        const min = half, max = width - half;
        this.timeLeft -= dt;
        if (this.pausing) {
            if (this.timeLeft <= 0) {
                this.pausing = false;
                this.speed = this.pickSpeed();
                if (this.random() < 0.4)
                    this.dir = this.dir === 1 ? -1 : 1;
                this.timeLeft = this.nextDecision();
            }
            return Math.min(max, Math.max(min, x));
        }
        // Turn round before the sprite touches a wall.
        const margin = this.config.turnMargin;
        if ((this.dir === 1 && x >= max - margin) || (this.dir === -1 && x <= min + margin))
            this.dir = this.dir === 1 ? -1 : 1;
        if (this.timeLeft <= 0) {
            const roll = this.random();
            if (roll < 0.35) {
                this.pause(this.uniform(this.config.pauseMinS, this.config.pauseMaxS));
                return x;
            }
            if (roll < 0.65)
                this.dir = this.dir === 1 ? -1 : 1;
            this.timeLeft = this.nextDecision();
        }
        return Math.min(max, Math.max(min, x + this.dir * this.speed * dt));
    }
    /** Stand still for `seconds` right now (the demo's snack stops). Only while he is allowed to walk. */
    rest(seconds) { if (this.on)
        this.pause(seconds); }
    pause(seconds) {
        this.pausing = true;
        this.timeLeft = seconds;
    }
}
