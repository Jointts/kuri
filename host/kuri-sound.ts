import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Plays Kurimanju's HAAAA, the same on macOS, Linux and Windows: no library, the platform's own player (afplay, PowerShell's
 * SoundPlayer, or the first of paplay, ffplay, mpv, play, aplay that is installed). Playback is a separate asynchronous
 * process that the animation never waits for: the HAAAA pose and its timing come from the animation, so a missing player, a
 * failed playback or sound switched off changes nothing visible.
 *
 * Safety: the file is passed to the player as an argument (never through a shell, never interpolated into a command string),
 * the player's output is discarded so it cannot disturb the terminal, and the process is killed when stopped, when it is
 * interrupted, and when the helper exits.
 */
/** The sound file in the mod's assets folder, which the mod hands to the helper. */
export const HAAAA_NAME = "kurimanju-haaaa.wav";

export interface PlayerCommand { command: string; args: string[]; env?: Record<string, string> }
type PlayerSpec = (file: string, volume: number) => Omit<PlayerCommand, "command">;
/** volume is 0..1 here; players that cannot change volume ignore it. */
const PLAYERS: { name: string; platforms: readonly NodeJS.Platform[]; build: PlayerSpec }[] = [
  { name: "afplay", platforms: ["darwin"], build: (file, volume) => ({ args: ["-v", String(volume), file] }) },
  // The file name travels in the environment, so it is never part of a command string.
  { name: "powershell.exe", platforms: ["win32"], build: (file) => ({ args: ["-NoProfile", "-NonInteractive", "-Command", "(New-Object Media.SoundPlayer $env:KURI_SOUND_FILE).PlaySync()"], env: { KURI_SOUND_FILE: file } }) },
  { name: "paplay", platforms: ["linux", "freebsd"], build: (file, volume) => ({ args: [`--volume=${Math.round(volume * 65536)}`, file] }) },
  { name: "ffplay", platforms: ["linux", "freebsd", "darwin"], build: (file, volume) => ({ args: ["-nodisp", "-autoexit", "-loglevel", "quiet", "-volume", String(Math.round(volume * 100)), file] }) },
  { name: "mpv", platforms: ["linux", "freebsd", "darwin"], build: (file, volume) => ({ args: ["--no-terminal", "--really-quiet", `--volume=${Math.round(volume * 100)}`, file] }) },
  { name: "play", platforms: ["linux", "freebsd"], build: (file, volume) => ({ args: ["-q", "-v", String(volume), file] }) },
  { name: "aplay", platforms: ["linux"], build: (file) => ({ args: ["-q", file] }) }
];

/** First executable called `command` on PATH (no shell involved). */
export function findOnPath(command: string, path = process.env.PATH ?? "", platform = process.platform): string | undefined {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try { accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK); return candidate; } catch { /* keep looking */ }
  }
  return undefined;
}

/** The player to use on `platform`, the first one installed, with its arguments for `file`. */
export function choosePlayer(file: string, volume: number, platform: NodeJS.Platform = process.platform, which: (command: string) => string | undefined = (c) => findOnPath(c)): PlayerCommand | undefined {
  for (const player of PLAYERS) {
    if (!player.platforms.includes(platform)) continue;
    const found = player.name === "afplay" && platform === "darwin" ? (existsSync("/usr/bin/afplay") ? "/usr/bin/afplay" : which(player.name)) : which(player.name);
    if (found) return { command: found, ...player.build(file, Math.max(0, Math.min(1, volume))) };
  }
  return undefined;
}

type Spawner = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
export interface SoundOptions {
  file: string; platform?: NodeJS.Platform; spawn?: Spawner; which?: (command: string) => string | undefined;
  enabled?: boolean; /** 0..100 */ volume?: number;
}

export class KuriSound {
  private child: ChildProcess | undefined;
  private on: boolean;
  private level: number;
  private broken = false;
  private plays = 0;
  private readonly file: string;
  private readonly platform: NodeJS.Platform;
  private readonly spawner: Spawner;
  private readonly which: ((command: string) => string | undefined) | undefined;
  private readonly killOnExit = () => { try { this.child?.kill(); } catch { /* already gone */ } };

  constructor(options: SoundOptions) {
    this.file = options.file;
    this.platform = options.platform ?? process.platform;
    this.spawner = options.spawn ?? (nodeSpawn as Spawner);
    this.which = options.which;
    this.on = options.enabled ?? true;
    this.level = Math.max(0, Math.min(100, options.volume ?? 70));
  }

  get enabled(): boolean { return this.on; }
  setEnabled(on: boolean): void { this.on = on; if (!on) this.stop(); }
  get volume(): number { return this.level; }
  setVolume(percent: number): void { this.level = Math.max(0, Math.min(100, percent)); }
  /** Whether a player was found and has not failed (the animation does not depend on it either way). */
  get available(): boolean { return !this.broken && existsSync(this.file) && choosePlayer(this.file, 1, this.platform, this.which) !== undefined; }
  get playing(): boolean { return this.child !== undefined; }
  /** How many times playback was started (for tests and `/kuri state`). */
  get started(): number { return this.plays; }
  /** Which player would be used, for status messages. */
  get player(): string | undefined { return choosePlayer(this.file, 1, this.platform, this.which)?.command; }

  /** Start the HAAAA. Returns whether a player was started; never throws and never waits. */
  play(): boolean {
    if (!this.on || this.broken) return false;
    this.stop();
    if (!existsSync(this.file)) { this.broken = true; return false; }
    const player = choosePlayer(this.file, this.level / 100, this.platform, this.which);
    if (!player) { this.broken = true; return false; }
    try {
      const child = this.spawner(player.command, player.args, { stdio: "ignore", windowsHide: true, shell: false, ...(player.env ? { env: { ...process.env, ...player.env } } : {}) });
      this.child = child;
      this.plays++;
      process.once("exit", this.killOnExit);
      // A player that cannot start (missing binary, no audio device) just turns the sound off: no message, no retry loop.
      child.once("error", () => { if (this.child === child) { this.child = undefined; this.broken = true; } process.removeListener("exit", this.killOnExit); });
      child.once("exit", () => { if (this.child === child) this.child = undefined; process.removeListener("exit", this.killOnExit); });
      return true;
    } catch {
      this.broken = true;
      return false;
    }
  }

  /** Stop playback now (an interrupted celebration, shutdown, or sound switched off). Safe to call any time. */
  stop(): void {
    const child = this.child;
    this.child = undefined;
    process.removeListener("exit", this.killOnExit);
    if (!child) return;
    try { child.kill(); } catch { /* already gone */ }
  }
}
