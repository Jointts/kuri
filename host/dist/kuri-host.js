import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATLAS_FILES } from "./atlas.js";
import { DEMO_STEPS, KuriController } from "./kuri-controller.js";
import { DEFAULT_TIMINGS } from "./kuri-machine.js";
import { DEFAULT_MAX_CANS } from "./kuri-physics.js";
import { encodePng } from "./kuri-png.js";
import { KuriScene } from "./kuri-scene.js";
import { HAAAA_NAME, KuriSound } from "./kuri-sound.js";
import { DEFAULT_WALKER } from "./kuri-walker.js";
const assets = process.argv[2];
const PREFIX = "kurimanju-";
const dir = mkdtempSync(join(tmpdir(), PREFIX));
writeFileSync(join(dir, "pid"), String(process.pid));
const sound = new KuriSound({ file: join(assets, HAAAA_NAME) });
const scene = new KuriScene(Object.fromEntries(ATLAS_FILES.map((name) => [name, new Uint8Array(readFileSync(join(assets, name)))])));
/** Removes this run's folder, and (once) the folders of runs that ended without doing it: a killed session, an older version. */
const removeOwn = () => { try {
    rmSync(dir, { recursive: true, force: true });
}
catch { /* best effort */ } };
function removeStale() {
    const alive = (pid) => { try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === "EPERM";
    } };
    for (const name of readdirSync(tmpdir())) {
        const path = join(tmpdir(), name);
        if (!name.startsWith(PREFIX) || path === dir)
            continue;
        try {
            let pid = NaN;
            try {
                pid = Number(readFileSync(join(path, "pid"), "utf8"));
            }
            catch { /* no pid file: an older version made it */ }
            const orphan = Number.isFinite(pid) ? !alive(pid) : Date.now() - statSync(path).mtimeMs > 10 * 60 * 1000;
            if (orphan)
                rmSync(path, { recursive: true, force: true });
        }
        catch { /* not ours, or gone already */ }
    }
}
process.on("exit", () => { sound.stop(); removeOwn(); });
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"])
    process.on(signal, () => process.exit(0));
removeStale();
const timings = { ...DEFAULT_TIMINGS };
const walker = { minSpeed: DEFAULT_WALKER.minSpeed, maxSpeed: DEFAULT_WALKER.maxSpeed };
let cols = 0;
let frame = 0;
let last;
let lastId = 0;
let inStamp = "";
let busy = false;
const say = (line) => process.stdout.write(line + "\n");
const controller = new KuriController(() => paint(), {
    timings, maxCans: DEFAULT_MAX_CANS, walker, sceneWidth: 45,
    timer: (fn, ms) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); },
    onSound: () => { sound.play(); }, onSoundStop: () => sound.stop()
});
function paint() {
    if (cols === 0 || busy)
        return;
    busy = true;
    try {
        const png = encodePng(scene.rgba({ cols, ...controller.snapshot() }));
        // Nothing visibly changed (he is only breathing between two identical frames): no new picture.
        if (last?.equals(png))
            return;
        last = png;
        frame++;
        const path = join(dir, `frame-${frame % 3}.png`);
        writeFileSync(path + ".tmp", png);
        renameSync(path + ".tmp", path);
        say(`frame ${frame}`);
    }
    finally {
        busy = false;
    }
}
function handle(message) {
    switch (message.kind) {
        case "event":
            controller.dispatch(message.event);
            return;
        case "resize":
            if (message.cols !== cols) {
                cols = message.cols;
                controller.resize(cols);
                last = undefined;
                paint();
            }
            return;
        case "throw":
            controller.throwCan();
            return;
        case "haaaa":
            controller.previewHaaaa();
            return;
        case "clear":
            controller.clearCans();
            return;
        case "demo":
            controller.startDemo((label) => say(`status ${label ? "demo: " + label : ""}`));
            return;
        case "eat":
            controller.eat(message.food);
            return;
        case "sound":
            sound.setVolume(message.volume);
            sound.setEnabled(message.isOn);
            return;
        case "walk":
            if (message.seconds > 0)
                controller.walkFor(message.seconds * 1000);
            else
                controller.stopDemo();
            return;
        case "cans":
            controller.physics.setMaxCans(Math.max(0, Math.floor(message.max)));
            return;
        case "speed":
            walker.minSpeed = message.min;
            walker.maxSpeed = message.max;
            controller.physics.walker.setConfig(walker);
            return;
        case "thresholds":
            if (message.reset)
                Object.assign(timings, DEFAULT_TIMINGS);
            else {
                if (message.hangoverSec !== undefined)
                    timings.hangoverAfterMs = message.hangoverSec * 1000;
                if (message.sleepSec !== undefined)
                    timings.sleepAfterMs = message.sleepSec * 1000;
            }
            controller.machine.setTimings(timings);
            return;
        case "quit":
            controller.dispose();
            process.exit(0);
    }
}
function poll() {
    try {
        const stat = statSync(join(dir, "in.json"));
        const stamp = `${stat.mtimeMs}:${stat.size}`;
        if (stamp === inStamp)
            return;
        inStamp = stamp;
        const messages = JSON.parse(readFileSync(join(dir, "in.json"), "utf8"));
        for (const message of messages) {
            if (message.id <= lastId)
                continue;
            lastId = message.id;
            handle(message);
        }
    }
    catch { /* not written yet, or caught mid-write: the next poll reads it */ }
}
function writeState() {
    const { machine, physics } = controller;
    const cans = physics.cans.filter((can) => can.kind === "can").length;
    const text = `${machine.kind}${machine.working ? " (working)" : ""}, ${cans} cans, ${physics.cans.length - cans} leftovers, x=${physics.centerX.toFixed(2)} facing ${physics.walker.dir === 1 ? "right" : "left"}${physics.walker.moving ? " walking" : ""}, thresholds ${JSON.stringify(machine.thresholds)}, demo has ${DEMO_STEPS.length} steps, audio ${sound.available ? sound.player : "no player found"}`;
    try {
        writeFileSync(join(dir, "state.json"), JSON.stringify({ text }));
    }
    catch { /* best effort */ }
}
say(`ready ${dir}`);
setInterval(poll, 25);
setInterval(writeState, 500);
// The mod's loop ending closes our stdout; there is nobody left to draw for.
process.stdout.on("error", () => process.exit(0));
