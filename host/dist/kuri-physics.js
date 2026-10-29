import { KuriWalker } from "./kuri-walker.js";
export const DEFAULT_PHYSICS = {
    gravity: 70, wallRestitution: 0.62, bodyRestitution: 0.42, canRestitution: 0.38,
    friction: 0.5, bounceThreshold: 5, sleepSpeed: 1.1, sleepSpin: 0.45, sleepAfterS: 0.4
};
/** The scene is one character tall: ceiling at the top of his box, floor under his feet (rendered 0.4 px above the edge). */
export const SCENE_HEIGHT = 12;
export const FLOOR_Y = 11.6;
export const CEILING_Y = 0;
export const MIN_WIDTH = 14;
export const DEFAULT_MAX_CANS = 30;
/** Kurimanju's body as an ellipse (px) standing on the floor; his x position is part of the world and moves. */
export const BODY = { rx: 4.9, ry: 5.4 };
/** Half the pet sprite's width (ears included): how close his centre may get to a wall. */
export const BODY_HALF = 5.5;
/** He starts a column in from the left edge, where the pet has always stood. */
export const START_X = BODY_HALF + 1;
/** The hand sits this far from his centre, on the side he throws toward. */
export const HAND_OFFSET = 6.7;
const STEP = 1 / 120;
const MAX_STEPS_PER_ADVANCE = 130;
const MAX_FRAME_S = 1;
const SOLVER_ITERATIONS = 10;
const SLOP = 0.02;
/** Contacts exist slightly before surfaces touch, so a resting can never flickers between touching and falling. */
const MARGIN = 0.08;
const CORRECTION = 0.3;
const WAKE_SPEED = 9;
/** A can he walks into is kicked ahead of him: speed, loft and forward spin are drawn from these ranges. */
const KICK_SPEED = [28, 45];
const KICK_LOFT = [8, 20];
const KICK_SPIN = [8, 18];
const KICK_COOLDOWN_S = 0.7;
/** Cans already moving faster than this when they meet him (a thrown can) bounce off him instead of being kicked. */
const KICKABLE_SPEED = 8;
const RADIUS = 0.78;
const CAN_W = 3.12, CAN_H = 4.2;
/** Local circle centers: two columns by three rows. */
const CIRCLES = [-1, 0, 1].flatMap((row) => [-1, 1].map((col) => [col * RADIUS, row * 1.32]));
/** A block of circles `cols` across by `rows` down (local px), so each leftover's collider matches its own sprite. */
const block = (cols, rows) => rows.flatMap((row) => cols.map((col) => [col, row]));
const WIDE = [-1.32, 0, 1.32], TALL = [-1.32, 0, 1.32];
/** Sprites are 4.2 px on their long side: the taco is 4.2 x 2.65 and the pizza slice 4.2 x 3.85 (both lying wide), the lime and wine bottles are 4.2 tall and about 1.5 wide. */
const SHAPES = {
    shell: block(WIDE, [-0.55, 0.55]),
    crust: block(WIDE, [-1.1, 1.1]),
    lime: block([-0.1, 0.1], TALL),
    wine: block([-0.1, 0.1], TALL)
};
const circlesOf = (kind) => SHAPES[kind] ?? CIRCLES;
const INV_MASS = 1;
const INV_INERTIA = 12 / (CAN_W * CAN_W + CAN_H * CAN_H);
export class KuriPhysics {
    bodies = [];
    calm = new Map();
    impacts = [];
    nextId = 1;
    lastMs;
    accumulator = 0;
    widthPx;
    cap;
    bodyXpos;
    bodyVx = 0;
    simTime = 0;
    kickedUntil = new Map();
    strider;
    random;
    config;
    constructor(options) {
        this.widthPx = Math.max(MIN_WIDTH, options.width);
        // He starts at the left, where the pet has always stood.
        this.bodyXpos = Math.min(this.widthPx - BODY_HALF, Math.max(BODY_HALF, options.bodyX ?? START_X));
        this.cap = Math.max(0, Math.floor(options.maxCans ?? DEFAULT_MAX_CANS));
        this.random = options.random ?? Math.random;
        this.config = { ...DEFAULT_PHYSICS, ...options.config };
        this.strider = new KuriWalker(this.random, options.walker);
    }
    get width() { return this.widthPx; }
    get cans() { return this.bodies; }
    get maxCans() { return this.cap; }
    /** Kurimanju's horizontal centre (a moving collision object, in the same world as the cans). */
    get centerX() { return this.bodyXpos; }
    /** His current velocity (columns per second), which every collision with him takes into account. */
    get bodyVelocity() { return this.bodyVx; }
    /** Where he wanders; the controller switches it on while the pet is in its walking state. */
    get walker() { return this.strider; }
    /** True while anything in the scene is moving (a can, or him walking), i.e. while it needs repainting. */
    get active() { return this.strider.moving || this.bodies.some((can) => !can.asleep); }
    /** Whether a can released from the hand on `facing`'s side would be inside the scene. */
    roomFor(facing) {
        const hand = this.bodyXpos + facing * HAND_OFFSET;
        return hand - 2.4 > 0 && hand + 2.4 < this.widthPx;
    }
    /** Place him (clamped so his whole sprite stays inside the walls). */
    setBodyX(x) { this.bodyXpos = Math.min(this.widthPx - BODY_HALF, Math.max(BODY_HALF, x)); }
    setMaxCans(max) {
        this.cap = Math.max(0, Math.floor(max));
        this.trim();
    }
    trim() {
        while (this.bodies.length > this.cap) {
            const sleeper = this.bodies.findIndex((can) => can.asleep);
            const [gone] = this.bodies.splice(sleeper >= 0 ? sleeper : 0, 1);
            if (gone)
                this.calm.delete(gone.id);
        }
    }
    uniform(min, max) { return min + (max - min) * this.random(); }
    /** Whether a can at (x, y, angle) would fit: inside the walls, clear of his body and of every other can. */
    fits(x, y, angle, kind = "can") {
        const c = Math.cos(angle), s = Math.sin(angle);
        const bodyY = FLOOR_Y - BODY.ry;
        const mine = circlesOf(kind).map(([lx, ly]) => ({ x: x + lx * c - ly * s, y: y + lx * s + ly * c }));
        for (const p of mine) {
            if (p.y + RADIUS > FLOOR_Y || p.y - RADIUS < CEILING_Y || p.x - RADIUS < 0 || p.x + RADIUS > this.widthPx)
                return false;
            const qx = p.x - this.centerX, qy = p.y - bodyY;
            const k0 = Math.hypot(qx / BODY.rx, qy / BODY.ry), k1 = Math.hypot(qx / (BODY.rx * BODY.rx), qy / (BODY.ry * BODY.ry));
            if (k1 === 0 || (k0 * (k0 - 1)) / k1 < RADIUS + 0.1)
                return false;
        }
        for (const other of this.bodies) {
            if (Math.hypot(other.x - x, other.y - y) > CAN_H + 0.6)
                continue;
            for (let n = 0; n < circlesOf(other.kind).length; n++) {
                const q = this.circle(other, n);
                if (mine.some((p) => Math.hypot(p.x - q.x, p.y - q.y) < RADIUS * 2 + 0.1))
                    return false;
            }
        }
        return true;
    }
    /**
     * A can leaves the hand on `facing`'s side (+1 right, -1 left) with randomized speed, loft and spin. `drop` is the
     * gentler version for leftovers he lets go of: released lower down, with a little push away from him.
     */
    spawn(facing, kind = "can", drop = false) {
        const angle = this.uniform(-0.3, 0.3);
        // Piles can grow up to the hand. Release from the nearest free spot (outward, then up/down) so a new can never
        // starts inside another one.
        const baseX = this.centerX + facing * HAND_OFFSET, baseY = FLOOR_Y - (drop ? 3.4 : 4.9);
        let x = baseX, y = baseY;
        search: for (let dx = 0; dx <= 14; dx += 0.7) {
            for (const side of [facing, -facing]) { // outward first; inward only if the hand is up against a wall
                for (const dy of [0, -0.8, -1.6, -2.4, -3.2, 0.8, 1.6]) {
                    if (this.fits(baseX + side * dx, baseY + dy, angle, kind)) {
                        x = baseX + side * dx;
                        y = baseY + dy;
                        break search;
                    }
                }
            }
        }
        const can = {
            id: this.nextId++, kind, x, y,
            vx: facing * (drop ? this.uniform(2, 7) : this.uniform(8, 22)), vy: -(drop ? this.uniform(2, 9) : this.uniform(10, 32)),
            angle, omega: drop ? this.uniform(-6, 6) : this.uniform(-13, 13), asleep: false
        };
        this.bodies.push(can);
        this.trim();
        return can;
    }
    /** Remove every can (the `/kurimanju-clear` command, new sessions). */
    clear() {
        this.bodies = [];
        this.calm.clear();
        this.kickedUntil.clear();
        this.impacts = [];
    }
    /**
     * Change the scene width. Walls move, and every can is set down again in free space nearest to where it was
     * (lowest first), so shrinking never leaves cans overlapping or outside; cans that cannot fit are dropped.
     */
    resize(width) {
        const next = Math.max(MIN_WIDTH, width);
        if (next === this.widthPx)
            return;
        this.widthPx = next;
        this.setBodyX(this.bodyXpos);
        const old = [...this.bodies].sort((a, b) => b.y - a.y);
        this.bodies = [];
        this.calm.clear();
        for (const can of old) {
            const targetX = Math.min(this.widthPx - 2, Math.max(2, can.x));
            search: for (let lift = 0; lift <= FLOOR_Y - 2.2; lift += 0.5) {
                const y = FLOOR_Y - 2.1 - lift;
                for (let step = 0; step <= this.widthPx; step += 1) {
                    for (const dx of step === 0 ? [0] : [step, -step]) {
                        for (const angle of [can.angle, Math.PI / 2, 0]) {
                            const x = targetX + dx;
                            if (!this.fits(x, y, angle, can.kind))
                                continue;
                            can.x = x;
                            can.y = y;
                            can.angle = angle;
                            can.vx = can.vy = can.omega = 0;
                            can.asleep = false;
                            this.bodies.push(can);
                            break search;
                        }
                    }
                }
            }
        }
    }
    /** Impacts since the last call (for the renderer's small flashes). */
    takeImpacts() {
        const out = this.impacts;
        this.impacts = [];
        return out;
    }
    /**
     * Catch the simulation up to wall-clock `nowMs` in fixed steps. A slow render only means more steps next time
     * (capped, so a long stall such as a suspended laptop does not run a burst of physics).
     */
    advance(nowMs) {
        if (this.lastMs === undefined) {
            this.lastMs = nowMs;
            return;
        }
        this.accumulator += Math.min(MAX_FRAME_S, Math.max(0, (nowMs - this.lastMs) / 1000));
        this.lastMs = nowMs;
        let steps = 0;
        while (this.accumulator >= STEP && steps < MAX_STEPS_PER_ADVANCE) {
            this.step(STEP);
            this.accumulator -= STEP;
            steps++;
        }
        if (steps === MAX_STEPS_PER_ADVANCE)
            this.accumulator = 0;
        // A paused walker still has a pause to count down, so only a fully quiet scene may drop spare time.
        if (!this.strider.enabled && !this.bodies.some((can) => !can.asleep))
            this.accumulator = 0;
    }
    /** Run `seconds` of simulation immediately (tests and tools). */
    simulate(seconds) {
        for (let t = 0; t < seconds; t += STEP)
            this.step(STEP);
    }
    /**
     * He does not go round cans: a resting (or slowly rolling) can he walks into, on the side he is heading, is kicked
     * ahead of him at great speed with some loft and forward spin, and he carries on walking.
     */
    kickCans(dir) {
        const bodyY = FLOOR_Y - BODY.ry;
        for (const can of this.bodies) {
            if ((can.x - this.bodyXpos) * dir <= 0)
                continue;
            if (!can.asleep && can.vx * can.vx + can.vy * can.vy > KICKABLE_SPEED * KICKABLE_SPEED)
                continue;
            if ((this.kickedUntil.get(can.id) ?? -1) > this.simTime)
                continue;
            for (let i = 0; i < circlesOf(can.kind).length; i++) {
                const { x, y } = this.circle(can, i);
                const qx = x - this.bodyXpos, qy = y - bodyY;
                const k0 = Math.hypot(qx / BODY.rx, qy / BODY.ry), k1 = Math.hypot(qx / (BODY.rx * BODY.rx), qy / (BODY.ry * BODY.ry));
                if (k1 === 0 || (k0 * (k0 - 1)) / k1 >= RADIUS + MARGIN)
                    continue;
                this.wake(can);
                can.vx = dir * this.uniform(...KICK_SPEED);
                can.vy = -this.uniform(...KICK_LOFT);
                can.omega = dir * this.uniform(...KICK_SPIN);
                this.kickedUntil.set(can.id, this.simTime + KICK_COOLDOWN_S);
                this.impacts.push({ x, y, speed: Math.hypot(can.vx, can.vy), kind: "kick" });
                break;
            }
        }
    }
    wake(can) {
        can.asleep = false;
        this.calm.set(can.id, 0);
        for (const other of this.bodies) {
            if (other.asleep && Math.hypot(other.x - can.x, other.y - can.y) < 5.5) {
                other.asleep = false;
                this.calm.set(other.id, 0);
            }
        }
    }
    step(dt) {
        const { gravity, friction } = this.config;
        this.simTime += dt;
        const before = this.bodyXpos;
        this.bodyXpos = this.strider.step(dt, this.bodyXpos, this.widthPx, BODY_HALF);
        this.bodyVx = (this.bodyXpos - before) / dt;
        if (this.bodyVx !== 0)
            this.kickCans(this.bodyVx > 0 ? 1 : -1);
        for (const can of this.bodies) {
            if (can.asleep)
                continue;
            can.vy += gravity * dt;
        }
        const contacts = this.contacts();
        for (const contact of contacts)
            this.prepare(contact);
        for (let i = 0; i < SOLVER_ITERATIONS; i++)
            for (const contact of contacts)
                this.solve(contact, friction);
        const grounded = new Set();
        const supported = new Set();
        for (const contact of contacts) {
            if (contact.kind === "floor")
                grounded.add(contact.a);
            if (contact.ny < -0.4)
                supported.add(contact.a);
            const push = Math.max(0, contact.pen - SLOP) * CORRECTION;
            if (push === 0)
                continue;
            const total = contact.invMassA + contact.invMassB || 1;
            contact.a.x += contact.nx * push * (contact.invMassA / total);
            contact.a.y += contact.ny * push * (contact.invMassA / total);
            if (contact.b && contact.invMassB > 0) {
                contact.b.x -= contact.nx * push * (contact.invMassB / total);
                contact.b.y -= contact.ny * push * (contact.invMassB / total);
            }
        }
        for (const can of this.bodies) {
            if (can.asleep)
                continue;
            // A can on the floor loses spin to rolling resistance, so it rolls a little and stops.
            if (grounded.has(can))
                can.omega *= 1 - 3.5 * dt;
            can.omega *= 1 - 0.25 * dt;
            // Slow and propped up (on the floor, a can or his body): soak up the last creep, as real friction would.
            if (supported.has(can) && can.vx * can.vx + can.vy * can.vy < 25) {
                const keep = 1 - 8 * dt;
                can.vx *= keep;
                can.vy *= keep;
                can.omega *= keep;
            }
            can.x += can.vx * dt;
            can.y += can.vy * dt;
            can.angle += can.omega * dt;
            if (can.angle > Math.PI * 4 || can.angle < -Math.PI * 4)
                can.angle %= Math.PI * 2;
            const slow = can.vx * can.vx + can.vy * can.vy < this.config.sleepSpeed ** 2 && Math.abs(can.omega) < this.config.sleepSpin;
            const calm = slow && (grounded.has(can) || supported.has(can)) ? (this.calm.get(can.id) ?? 0) + dt : 0;
            this.calm.set(can.id, calm);
            if (calm >= this.config.sleepAfterS) {
                can.asleep = true;
                can.vx = can.vy = can.omega = 0;
            }
        }
    }
    /** World position of circle `index` of a can. */
    circle(can, index) {
        const [lx, ly] = circlesOf(can.kind)[index];
        const c = Math.cos(can.angle), s = Math.sin(can.angle);
        return { x: can.x + lx * c - ly * s, y: can.y + lx * s + ly * c };
    }
    contacts() {
        const out = [];
        const { wallRestitution, bodyRestitution, canRestitution } = this.config;
        const bodyX = this.centerX, bodyY = FLOOR_Y - BODY.ry;
        const awake = this.bodies.filter((can) => !can.asleep);
        const add = (a, b, nx, ny, px, py, pen, kind, restitution) => {
            out.push({ a, b, nx, ny, px, py, pen, kind, restitution, invMassA: INV_MASS, invInertiaA: INV_INERTIA, invMassB: 0, invInertiaB: 0,
                rax: 0, ray: 0, rbx: 0, rby: 0, kn: 1, kt: 1, bounce: 0, pn: 0, pt: 0 });
        };
        for (const can of awake) {
            for (let i = 0; i < circlesOf(can.kind).length; i++) {
                const { x, y } = this.circle(can, i);
                if (y + RADIUS > FLOOR_Y - MARGIN)
                    add(can, undefined, 0, -1, x, FLOOR_Y, y + RADIUS - FLOOR_Y, "floor", wallRestitution);
                if (y - RADIUS < CEILING_Y + MARGIN)
                    add(can, undefined, 0, 1, x, CEILING_Y, CEILING_Y - (y - RADIUS), "ceiling", wallRestitution);
                if (x - RADIUS < MARGIN)
                    add(can, undefined, 1, 0, 0, y, RADIUS - x, "wall", wallRestitution);
                if (x + RADIUS > this.widthPx - MARGIN)
                    add(can, undefined, -1, 0, this.widthPx, y, x + RADIUS - this.widthPx, "wall", wallRestitution);
                // Kurimanju: signed distance to an axis-aligned ellipse (negative inside), normal from its gradient.
                const qx = x - bodyX, qy = y - bodyY;
                const k0 = Math.hypot(qx / BODY.rx, qy / BODY.ry);
                const k1 = Math.hypot(qx / (BODY.rx * BODY.rx), qy / (BODY.ry * BODY.ry));
                const distance = k1 === 0 ? -Math.min(BODY.rx, BODY.ry) : k0 * (k0 - 1) / k1;
                if (distance < RADIUS + MARGIN) {
                    const gx = k1 === 0 ? 0 : qx / (BODY.rx * BODY.rx) / k1, gy = k1 === 0 ? -1 : qy / (BODY.ry * BODY.ry) / k1;
                    add(can, undefined, gx, gy, x - gx * RADIUS, y - gy * RADIUS, RADIUS - distance, "body", bodyRestitution);
                }
            }
        }
        // Can against can: any pair where at least one is awake; sleepers are static unless hit hard.
        for (let i = 0; i < this.bodies.length; i++) {
            for (let j = i + 1; j < this.bodies.length; j++) {
                const a = this.bodies[i], b = this.bodies[j];
                if (a.asleep && b.asleep)
                    continue;
                if (Math.hypot(a.x - b.x, a.y - b.y) > CAN_H + 0.2)
                    continue;
                for (let m = 0; m < circlesOf(a.kind).length; m++) {
                    const ca = this.circle(a, m);
                    for (let n = 0; n < circlesOf(b.kind).length; n++) {
                        const cb = this.circle(b, n);
                        const dx = ca.x - cb.x, dy = ca.y - cb.y, distance = Math.hypot(dx, dy);
                        if (distance >= RADIUS * 2 + MARGIN)
                            continue;
                        const nx = distance === 0 ? 0 : dx / distance, ny = distance === 0 ? -1 : dy / distance;
                        // `a` is always the awake one so the solver moves it; `b` may be asleep (static) or awake.
                        if (a.asleep)
                            add(b, a, -nx, -ny, (ca.x + cb.x) / 2, (ca.y + cb.y) / 2, RADIUS * 2 - distance, "can", canRestitution);
                        else
                            add(a, b, nx, ny, (ca.x + cb.x) / 2, (ca.y + cb.y) / 2, RADIUS * 2 - distance, "can", canRestitution);
                    }
                }
            }
        }
        return out;
    }
    prepare(contact) {
        const { a, b } = contact;
        if (b) {
            // A sleeper only joins the simulation when struck hard; otherwise it acts as part of the floor.
            const closing = Math.abs((a.vx - b.vx) * contact.nx + (a.vy - b.vy) * contact.ny);
            if (b.asleep && closing > WAKE_SPEED)
                this.wake(b);
            if (!b.asleep) {
                contact.invMassB = INV_MASS;
                contact.invInertiaB = INV_INERTIA;
            }
        }
        contact.rax = contact.px - a.x;
        contact.ray = contact.py - a.y;
        if (b) {
            contact.rbx = contact.px - b.x;
            contact.rby = contact.py - b.y;
        }
        const raN = contact.rax * contact.ny - contact.ray * contact.nx;
        const rbN = contact.rbx * contact.ny - contact.rby * contact.nx;
        contact.kn = contact.invMassA + contact.invMassB + contact.invInertiaA * raN * raN + contact.invInertiaB * rbN * rbN;
        const raT = contact.rax * contact.nx + contact.ray * contact.ny, rbT = contact.rbx * contact.nx + contact.rby * contact.ny;
        contact.kt = contact.invMassA + contact.invMassB + contact.invInertiaA * raT * raT + contact.invInertiaB * rbT * rbT;
        const vn = this.relative(contact).vn;
        if (vn < -this.config.bounceThreshold) {
            contact.bounce = -contact.restitution * vn;
            // Two circles of one can often land together; report that as a single impact.
            const twin = this.impacts.slice(-4).some((hit) => hit.kind === contact.kind && Math.hypot(hit.x - contact.px, hit.y - contact.py) < 2);
            if (!twin)
                this.impacts.push({ x: contact.px, y: contact.py, speed: -vn, kind: contact.kind });
        }
    }
    relative(contact) {
        const { a, b } = contact;
        const avx = a.vx - a.omega * contact.ray, avy = a.vy + a.omega * contact.rax;
        // Static surfaces stand still; Kurimanju moves (horizontally) at his walking velocity.
        const bvx = b && contact.invMassB > 0 ? b.vx - b.omega * contact.rby : contact.kind === "body" ? this.bodyVx : 0;
        const bvy = b && contact.invMassB > 0 ? b.vy + b.omega * contact.rbx : 0;
        const rx = avx - bvx, ry = avy - bvy;
        return { vn: rx * contact.nx + ry * contact.ny, vt: rx * -contact.ny + ry * contact.nx };
    }
    apply(contact, jx, jy) {
        const { a, b } = contact;
        a.vx += jx * contact.invMassA;
        a.vy += jy * contact.invMassA;
        a.omega += contact.invInertiaA * (contact.rax * jy - contact.ray * jx);
        if (b && contact.invMassB > 0) {
            b.vx -= jx * contact.invMassB;
            b.vy -= jy * contact.invMassB;
            b.omega -= contact.invInertiaB * (contact.rbx * jy - contact.rby * jx);
        }
    }
    solve(contact, friction) {
        const { vn } = this.relative(contact);
        // Normal impulse, accumulated and clamped so contacts can only push.
        const lambda = -(vn - contact.bounce) / contact.kn;
        const pn = Math.max(0, contact.pn + lambda);
        const dn = pn - contact.pn;
        contact.pn = pn;
        this.apply(contact, contact.nx * dn, contact.ny * dn);
        // Friction opposes sliding, bounded by the normal force.
        const { vt } = this.relative(contact);
        const lt = -vt / contact.kt;
        const limit = friction * contact.pn;
        const pt = Math.max(-limit, Math.min(limit, contact.pt + lt));
        const dt = pt - contact.pt;
        contact.pt = pt;
        this.apply(contact, -contact.ny * dt, contact.nx * dt);
    }
}
