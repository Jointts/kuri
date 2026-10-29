import type { EngineInterface, Register } from 'claude-code'

/**
 * Kurimanju, ported from the pi extension: a pet in the band above the prompt, driven by Claude Code's turn events.
 *
 * The mod runtime is one thread shared with the engine's rendering, so the pet itself (simulation, compositing, PNG
 * encoding) runs in its own Node process, host/kuri-host.ts. This module only
 *   - spawns it and tells it what Claude is doing (`<dir>/in.json`),
 *   - points the band's Image at each frame file the process announces on stdout (`$.ui.blit`, a `file` source the
 *     terminal reads itself, so no pixels pass through here),
 *   - plays the HAAAA sound when the process says so.
 *
 * Claude event → pet event (host/kuri-machine.ts):
 *   turn.start (main loop)                      → work-start   (wake if needed, then walk)
 *   tool.call, prompt.submit                    → activity     (keeps walking; resets the idle clocks)
 *   turn.complete, reason "answer"              → work-end + response-done (beer → drinking → HAAAA → throw a can)
 *   turn.complete, any other reason             → work-end only (cancelled or failed: no can)
 */
const PET = 'pet'
const SCENE_ROWS = 6
const MAX_SCENE_COLS = 56
const MIN_SCENE_COLS = 20
/** Tool calls can come in bursts; the idle clocks need no more than this. */
const ACTIVITY_THROTTLE_MS = 300
/** One transparent RGBA pixel, drawn until the first frame exists. */
const BLANK = { rgba: 'AAAAAA==', width: 1, height: 1 } as const

const DEFAULT_WALK_SECONDS = 15
const MAX_WALK_SECONDS = 300

/** The snacks he can be sent to eat (host/kuri-machine.ts). */
const DRINKS = ['beer', 'lime', 'wine']
const FOODS = ['pizza', 'taco', ...DRINKS]

type Message = { kind: string; [key: string]: unknown }

// $ may only be handed to functions declared at the top of this file, so the helpers live here and the pet's state
// is module-level (a reload starts it over).
const pet: {
  dir: string
  isRunning: boolean
  isVisible: boolean
  isSoundOn: boolean
  volume: number
  band?: string
  cols: number
  frame: number
  messages: Array<Message & { id: number }>
  nextId: number
  writing: Promise<unknown>
  lastActivity: number
} = {
  dir: '',
  isRunning: false,
  isVisible: true,
  isSoundOn: true,
  volume: 70,
  cols: 0,
  frame: 0,
  messages: [],
  nextId: 1,
  writing: Promise.resolve(),
  lastActivity: 0,
}

/** Writes the messages to the file the pet polls; until it has said where its folder is (`ready`), they wait in memory. */
function writeInbox($: EngineInterface) {
  if (pet.dir === '') {
    return
  }
  const text = JSON.stringify(pet.messages)
  pet.writing = pet.writing.then(() => $.fs.write(`${pet.dir}/in.json`, text)).catch(() => undefined)
}

/** Hands the pet a message: the last few are kept in one file it polls, each handled once by its id. */
function post($: EngineInterface, message: Message) {
  if (!pet.isRunning) {
    return
  }
  pet.messages = [...pet.messages, { ...message, id: pet.nextId++ }].slice(-40)
  writeInbox($)
}

/** The pet plays the HAAAA itself, with the platform's own audio player: it needs to know whether, and how loud. */
function postSound($: EngineInterface) {
  post($, { kind: 'sound', isOn: pet.isSoundOn, volume: pet.volume })
}

/** The sound setting survives reloads and new sessions: it is kept in the mod's store. */
async function loadSound($: EngineInterface) {
  const saved = await $.store.get('sound').catch(() => undefined)
  if (saved && typeof saved === 'object') {
    const { isOn, volume } = saved as { isOn?: unknown; volume?: unknown }
    pet.isSoundOn = typeof isOn === 'boolean' ? isOn : pet.isSoundOn
    pet.volume = typeof volume === 'number' && volume >= 0 && volume <= 100 ? volume : pet.volume
  }
}

async function start($: EngineInterface) {
  if (pet.isRunning) {
    return
  }
  await loadSound($)
  pet.isRunning = true
  pet.dir = ''        // the pet makes its own temp folder and says where it is
  pet.messages = []
  pet.frame = 0
  // A new process knows no width yet: forget the old one so the next render tells it (else it never draws a frame).
  pet.cols = 0
  pet.writing = Promise.resolve()
  postSound($)
  void (async () => {
    try {
      const host = $.process.spawn({
        argv: ['node', `${$.plugin.root}/host/dist/kuri-host.js`, `${$.plugin.root}/assets`],
      })
      for await (const piece of host) {
        if (!('text' in piece)) {
          continue
        }
        if (piece.stream === 'stderr') {
          $.ui.log(`kurimanju host: ${piece.text}`, { to: 'debug' })
          continue
        }
        let newest = 0
        for (const line of piece.text.split('\n')) {
          if (line.startsWith('frame ')) {
            newest = Number(line.slice(6))
          } else if (line.startsWith('ready ')) {
            pet.dir = line.slice(6).trim()
            writeInbox($)
          } else if (line.startsWith('status ')) {
            $.ui.status(line.slice(7) || undefined)
          }
        }
        // Several frames in one chunk: only the newest is worth showing.
        if (newest > 0 && pet.band !== undefined && pet.isVisible) {
          pet.frame = newest
          await $.ui.blit({
            requestId: pet.band,
            key: PET,
            source: { file: `${pet.dir}/frame-${newest % 3}.png`, format: 'png', generation: newest },
          })
        }
      }
    } catch (error) {
      $.ui.toast(`Kurimanju could not start his process: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      pet.isRunning = false
      pet.dir = ''
    }
  })()
  $.ui.invalidate('ui.render')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    if (e.isInteractive) {
      await $.command.register({
        name: 'kuri',
        description:
          'Kurimanju: show | hide | demo | walk [seconds|stop] | eat <pizza|taco|beer|lime|wine> | drink <beer|lime|wine> | state | haaaa | throw | clear | sound on|off|volume <0-100> | cans <n> | speed <min> [max] | thresholds <hangoverSec> [sleepSec]|reset',
      })
      await start($)
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    post($, { kind: 'quit' })

    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) {
      post($, { kind: 'event', event: 'work-start' })
    }

    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) {
      post($, { kind: 'event', event: 'work-end' })
      if (e.reason === 'answer') {
        post($, { kind: 'event', event: 'response-done' })
      }
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const now = await $.clock.now()
    if (now - pet.lastActivity >= ACTIVITY_THROTTLE_MS) {
      pet.lastActivity = now
      post($, { kind: 'event', event: 'activity' })
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', ($, e, next) => {
    post($, { kind: 'event', event: 'activity' })

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    const wanted = Math.min(MAX_SCENE_COLS, e.props.bodyColumns)
    if (e.surface !== 'terminal' || !pet.isRunning || !pet.isVisible || wanted < MIN_SCENE_COLS || e.props.hasSurvey) {
      pet.band = undefined

      return next(e)
    }
    pet.band = e.requestId
    if (wanted !== pet.cols) {
      pet.cols = wanted
      post($, { kind: 'resize', cols: wanted })
    }
    const { Box, Image } = $.ui.resolve(e)
    const source =
      pet.frame > 0
        ? ({ file: `${pet.dir}/frame-${pet.frame % 3}.png`, format: 'png', generation: pet.frame } as const)
        : BLANK

    return (
      <Box>
        <Image key={PET} source={source} columns={pet.cols} rows={SCENE_ROWS} alt=" " />
      </Box>
    )
  })

  on('command.run', { command: 'kuri' }, async ($, e) => {
    const [mode = 'show', ...rest] = e.args.trim().split(/\s+/)
    const number = Number(rest[0])
    const text = (words: string) => ({ text: words })
    const ensure = async () => {
      pet.isVisible = true
      await start($)
    }

    switch (mode) {
      case 'hide':
        pet.isVisible = false
        post($, { kind: 'quit' })
        $.ui.invalidate('ui.render')

        return text('Kurimanju is hidden.')
      case 'show':
      case '':
        await ensure()

        return text('Kurimanju is here.')
      case 'state': {
        if (!pet.isRunning) {
          return text('Kurimanju is hidden.')
        }
        const state = await $.fs.read(`${pet.dir}/state.json`).catch(() => '{}')
        const parsed = JSON.parse(String(state)) as { text?: string }

        return text(`Kurimanju: ${parsed.text ?? 'starting'}, sound ${pet.isSoundOn ? 'on' : 'off'} ${pet.volume}%, frame ${pet.frame}.`)
      }
      case 'haaaa':
        await ensure()
        post($, { kind: 'haaaa' })

        return text('HAAAA.')
      case 'throw':
        await ensure()
        post($, { kind: 'throw' })

        return text('Threw a can.')
      case 'clear':
        post($, { kind: 'clear' })

        return text('Removed every can.')
      case 'sound': {
        const word = rest[0] ?? 'status'
        if (word === 'on' || word === 'off') {
          pet.isSoundOn = word === 'on'
        } else if (word === 'volume') {
          const level = Number(rest[1])
          if (rest[1] === undefined || !Number.isFinite(level) || level < 0 || level > 100) {
            return text('Usage: /kuri sound volume <0-100>')
          }
          pet.volume = level
        } else if (word !== 'status') {
          return text('Usage: /kuri sound on|off|volume <0-100>|status')
        }

        await $.store.set('sound', { isOn: pet.isSoundOn, volume: pet.volume }).catch(() => undefined)
        postSound($)
        const state = pet.dir === '' ? '' : await $.fs.read(`${pet.dir}/state.json`).catch(() => '')
        const audio = /audio ([^"]*?)"/.exec(String(state))?.[1]
        const player = audio === undefined ? '' : audio === 'no player found' ? ' No audio player found on this machine, so there will be no sound.' : ''

        return text(`HAAAA sound ${pet.isSoundOn ? 'on' : 'off'}, volume ${pet.volume}%.${player}`)
      }
      case 'cans':
        if (!Number.isFinite(number) || number < 0) {
          return text('Usage: /kuri cans <max>')
        }
        post($, { kind: 'cans', max: number })

        return text(`Kurimanju keeps at most ${Math.floor(number)} cans.`)
      case 'speed': {
        const max = rest[1] === undefined ? number : Number(rest[1])
        if (!Number.isFinite(number) || number <= 0 || !Number.isFinite(max) || max < number) {
          return text('Usage: /kuri speed <min> [max] columns per second')
        }
        post($, { kind: 'speed', min: number, max })

        return text(`Kurimanju walks ${number}-${max} columns per second.`)
      }
      case 'thresholds': {
        if (rest[0] === 'reset') {
          post($, { kind: 'thresholds', reset: true })

          return text('Idle thresholds reset.')
        }
        const sleep = rest[1] === undefined ? undefined : Number(rest[1])
        if (!Number.isFinite(number) || number < 0 || (sleep !== undefined && (!Number.isFinite(sleep) || sleep < 0))) {
          return text('Usage: /kuri thresholds <hangoverSeconds> [sleepSeconds] | reset')
        }
        post($, { kind: 'thresholds', hangoverSec: number, sleepSec: sleep })

        return text(`Hangover after ${number}s idle${sleep === undefined ? '' : `, asleep ${sleep}s later`} (this session only).`)
      }
      case 'walk': {
        const seconds = rest[0] === 'stop' ? 0 : rest[0] === undefined ? DEFAULT_WALK_SECONDS : number
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_WALK_SECONDS) {
          return text(`Usage: /kuri walk [1-${MAX_WALK_SECONDS} seconds | stop]`)
        }
        await ensure()
        post($, { kind: 'walk', seconds })

        return text(seconds === 0 ? 'Kurimanju stops walking.' : `Kurimanju walks for ${seconds}s.`)
      }
      case 'eat':
      case 'drink': {
        const food = rest[0] ?? ''
        const allowed = mode === 'drink' ? DRINKS : FOODS
        if (!allowed.includes(food)) {
          return text(`Usage: /kuri ${mode} ${allowed.join('|')}`)
        }
        await ensure()
        post($, { kind: 'eat', food })

        return text(`Kurimanju stops for ${food}.`)
      }
      case 'demo':
        await ensure()
        post($, { kind: 'demo' })

        return text('Kurimanju demo: any real activity stops it.')
      default:
        return text('Usage: /kuri show|hide|demo|walk|eat|drink|state|haaaa|throw|clear|sound|cans|speed|thresholds')
    }
  })
}
