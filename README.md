<p align="center"><img src=".claude-plugin/icon.png" alt="Kurimanju" width="160"></p>

# Kurimanju

An animated pet that lives above the prompt in [Claude Code](https://claude.com/claude-code) and reacts to what Claude is actually doing.

- **Claude is working**: he walks across the terminal, kicking up a little dust puff at every step.
- **He pauses**: he has a snack. A slice of pizza, a taco, a beer, a lime drink or a bottle of wine, picked at random. Crumbs, shreds of lettuce or drops of drink fly out with every bite and sip, then land and lie on the floor for a few seconds before they fade. What is left of the snack drops behind him when he sets off again.
- **A response finishes**: he drinks a beer, shouts **HAAAA** (with sound), and throws the empty can across the terminal. Cans bounce, tumble, collide and pile up on the floor.
- **The turn was cancelled or failed**: he goes back to standing, with no beer and no can.
- **You walk away**: after 30 s he gets a hangover, after 45 s he falls over and sleeps. Submitting a prompt or a tool call wakes him up.

Nothing to configure: install it and start a session.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install kurimanju --marketplace Jointts/kuri
```

Answer `y` to add the marketplace and pick a scope. He starts walking in that session, with no reload. From a shell the same thing is `claude plugin install kurimanju --marketplace Jointts/kuri`.

## What you need

- **Claude Code with mods** (the function-hooks API is early access and may change between releases; this was built on 2.1.312).
- **Node.js 18 or newer** on your `PATH`. The pet runs in its own small process so it never slows Claude's own rendering. It is plain JavaScript, with no packages to install.
- **A terminal that draws images**: Ghostty, Kitty, WezTerm or iTerm2 3.5+. In other terminals the band above the prompt stays empty. Inside tmux, `allow-passthrough` and `focus-events` must be on.
- **Sound** (optional) plays through the platform's own player, started separately so it never blocks anything: `afplay` on macOS, PowerShell's `SoundPlayer` on Windows, and the first of `paplay`, `ffplay`, `mpv`, `play` (sox) or `aplay` on Linux. No player? Everything else still works. `/kuri sound` tells you if none was found.

## Commands

All of them run locally and cost no tokens.

| Command | What it does |
|---|---|
| `/kuri show` / `hide` | show or hide the pet |
| `/kuri demo` | plays every animation once, about 45 s; any real activity stops it |
| `/kuri walk [seconds\|stop]` | makes him walk for a while (default 15 s) |
| `/kuri eat pizza\|taco\|beer\|lime\|wine` | makes him stop and have that snack right now |
| `/kuri drink beer\|lime\|wine` | the same, drinks only |
| `/kuri haaaa` | previews the HAAAA pose and sound, with no can |
| `/kuri throw` / `clear` | throws a test can / removes every can |
| `/kuri sound on\|off\|volume <0-100>` | the HAAAA sound (default on, volume 70). Remembered between sessions. |
| `/kuri cans <n>` | most cans and leftovers kept on the floor (default 30) |
| `/kuri speed <min> [max]` | walking speed in columns per second (default 3 to 6) |
| `/kuri thresholds <hangoverSec> [sleepSec]` / `reset` | shorten the idle times to see the sleep animations (this session only) |
| `/kuri state` | what he is doing, where he is, how many cans |

## How it follows Claude

| Claude Code event | He |
|---|---|
| a turn starts (the main loop, not subagents) | starts walking; every pause in the walk is a snack |
| a tool call, or you submit a prompt | counts as activity: keeps him awake and walking |
| a turn ends with an answer | beer, HAAAA and sound, then throws the can |
| a turn ends cancelled or failed | back to idle, no can |

Claude Code gives a mod no key presses, so only prompts and tool calls reset his idle clocks. If you type a very long prompt he may doze off.

## How it works

The mod itself (`hooks/register.tsx`) only listens to those events, tells the pet about them, and draws each finished frame as an `Image` in the band above the prompt. The pet is `host/dist/kuri-host.js`, a separate Node process that runs the animation state machine, the can physics, the particles and the compositing, and writes each frame as a PNG to its own temp folder. That folder is removed when the pet exits, and a folder left by a crashed run is cleaned up on the next start. The sprites are raw RGBA atlases in `assets/`.

## What it runs, writes and sends

Everything stays on your machine.

**Sends.** Nothing, anywhere. The mod makes no network requests and uses no MCP servers. Its two parts only talk to each other through files in a temp folder and through the helper's standard output.

**Runs.**
- `node` (18 or newer), to start the pet's helper: `node host/dist/kuri-host.js <the mod's assets folder>`. The helper is plain, readable JavaScript compiled from the TypeScript next to it. It runs for as long as the session does.
- The platform's own audio player, started by the helper to play the HAAAA (`assets/kurimanju-haaaa.wav`) and nothing else: `afplay` on macOS, PowerShell's built-in `SoundPlayer` (`powershell.exe`) on Windows, and the first of `paplay`, `ffplay`, `mpv`, `play` or `aplay` that is installed on Linux. The sound file is passed to the player as an argument, never through a shell. `/kuri sound off` turns the whole thing off.

**Writes.**
- Into one temp folder of its own, `kurimanju-XXXXXX` in your system temp directory: the messages the mod sends the helper (`in.json`), what `/kuri state` reads back (`state.json`), the latest frames as PNG files, and the helper's process id. The helper removes the folder when it exits, and clears one left behind by a crashed run the next time it starts.
- Your sound setting (on or off, and the volume), in the mod's own store, so it survives restarts.

It never edits a build, start-up, settings or instructions file, or anything in your project, and it reads no files other than its own.

**Credentials.** It reads none and sends none. The helper reads `PATH` to find an audio player, and hands its environment to the Windows audio player because PowerShell needs it to start.

**What the hooks do.** They only watch; none blocks, rewrites or delays anything. At the start and end of a turn, on every tool call and on every prompt you submit, the mod tells the pet what is going on (`turn.start`, `turn.complete`, `tool.call` and `prompt.submit` always pass the event straight on). It draws the pet in the band above the prompt (`ui.render`), answers the `/kuri` commands (`command.run`), and starts and stops the helper (`session.start` and `session.end`).

## Building from source

The helper's TypeScript is in `host/`; the compiled JavaScript in `host/dist/` is what runs. After changing anything in `host/`, run `scripts/build-host.sh` (needs `tsc` and `@types/node`) and commit the result. The scripts that generate the sprites (`scripts/build-*.py`, `bake-assets.py`, `unify-colors.py`) need the original artwork, which is not part of this repository, so they are here as a record of how the frames were made rather than something to rerun.

## License

The code is MIT, see [LICENSE](LICENSE). The character, the artwork and the HAAAA sound are **not** covered by it: Kurimanju is a fan project and those belong to their rights holders, see [NOTICE.md](NOTICE.md).
