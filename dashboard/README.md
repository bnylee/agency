# Agency control plane

Local interface for the Agency bots. Designed by the `interface-design` bot; the
design system it implements lives in `interface-design/design/`.

## Run it

```bash
cd dashboard
npm install
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # paste into AGENCY_TOKEN
npm run dev
```

Then open <http://127.0.0.1:5173> and paste the same token when prompted.

## What it can and cannot do

| Can | Cannot |
| --- | --- |
| View every bot's status, schedule, reports and token spend | Delete anything |
| Trigger `sam-research` and `finance-research` runs | Purge a quarantine batch |
| Trigger `disk-cleanup` and `agency-repair` **in dry-run mode only** | Uninstall anything |
| Restore a quarantine batch | Apply a repair |
| Revert an `agency-repair` batch | Place a real trade |
| Read `finance-research`'s simulated paper account | Run an arbitrary command |
| Read `media-bot`'s digest, calendar and trash bin | Stage or restore mail |
| Open the standalone HTML page a run rendered | Send, reply to or delete a message |
| Queue a repair request for `agency-repair` | Write anything else into the Agency |

**There is no purge endpoint, and adding one would be a mistake.** `purge.ps1` is
the only thing in the Agency that permanently deletes, and it is protected by two
locks: `disk-cleanup`'s command guard refuses to invoke it, and the script itself
refuses to run without an interactive console and a typed confirmation. An HTTP
endpoint would defeat both. Purging stays a deliberate act at a terminal.

**Restore and revert are exposed; purge is not — and the line is not "how scary
does it sound".** Both restore and revert put files *back* from copies taken
beforehand, and neither destroys anything: `revert.ps1` moves a bot-created file
aside rather than deleting it. Purge is the one operation with no inverse, so it
is the one operation with no endpoint.

`disk-cleanup` and `agency-repair` are triggerable only with `-DryRun`, for
related reasons. A browser button that stages 22 GB of file moves is not
something to offer casually; nor is one that rewrites the source of the control
plane you are clicking in. Live runs stay on the schedule or on an explicit
terminal invocation.

The portfolio view is **read-only and simulated**. There is no order endpoint,
because there is no brokerage: `finance-research` moves numbers inside its own
`state/portfolio.json` and nothing else.

## Security model

This API starts PowerShell. That is the whole reason for the constraints:

- **Loopback only.** The server refuses to start on a non-loopback host, and
  re-checks the peer address on every request. `vite.config.ts` binds `127.0.0.1`
  for the same reason — do not add `host: true`.
- **Token in a header, never a cookie.** Browsers attach cookies to cross-site
  requests automatically; they will not attach a custom header without a CORS
  preflight this server never approves. That asymmetry is the CSRF defence.
- **No user input reaches a command line.** A request's `:id` selects an entry
  from the hardcoded map in `server/registry.ts`; the script path and its
  arguments come from that entry only. `spawn` is called with an argument array
  and `shell: false`.
- **Date and batch parameters are shape-checked** against `^\d{4}-\d{2}-\d{2}$`
  before any path is built, so a traversal sequence is never joined to a real
  directory.
- **Triggers are rate-limited** (30 s) and refuse a second concurrent run.

## Design

### Composition — rail and stage

The chrome is an **L**: an opaque topbar over an opaque 384px left rail. Every
control lives in the rail; the rest of the width is **stage** that nothing
overlays, and the studio re-centres into it via `camera.setViewOffset`. The
earlier layout floated translucent cards across the middle of the viewport,
which meant the most distinctive thing in the product was obscured by the least
distinctive things in it.

The chrome is opaque for a contrast reason, not a stylistic one. Every status
contrast figure is measured against `#1a1a19`; a translucent rail would put
status text over whatever the studio happened to render behind it. The rail
paints `--page` (`#0d0d0d`), which is *darker* than the validated surface and so
strictly higher contrast for every status colour — **no figure needed
recomputing, and `--surface` was not touched.**

Below 920px there is no room for both, so the rail becomes the page and the
stage is given up rather than squeezed.

### Selecting a bot — the zoom, and the scrim that is not there

Clicking a bot dollies the camera onto that machine over **760 ms** and opens a side
sheet carrying that bot's **Options**: what it can be told to do, above what it
has already done.

The camera move is Register A, which is the only reason it is allowed to take
760 ms while the sheet it accompanies stays inside Register B's 500 ms budget.
The two are deliberately unsynchronised — the controls arrive first and are
usable immediately, and the world settles behind them. It is a pure dolly along
the existing view axis, not an orbit: the world does not spin under you, it
comes closer. The focused machine keeps full brightness while every other one is
pushed back to 34%, and it aims at the bot's eye height rather than the floor, so
the indicator panel and the dial are both in frame.

Selecting a *different* bot while zoomed retreats to the overview, swaps the
anchor at the trough, and flies in again. Panning directly between two close-up
poses drags the camera across the whole room at high magnification and reads as a
blur; pulling back reads as a decision.

The panel also feeds its own width back into `setStageInset`, so the studio
re-centres into the stage that is left over — on the sheet's curve and duration,
so the scene and the sheet move as one thing.

**There is deliberately no scrim behind the panel, and it is not `aria-modal`.**
It was both, and that made the rail and the studio dead for as long as a panel
was open: you had to close one bot before you could look at the next. The motion
spec says of Register A that it *never blocks interaction; the user can click
through it at any moment*, and a full-viewport overlay is the most complete way
to break that. The scrim's two jobs are already done better elsewhere — the
scene dims itself and pushes unfocused machines back, which is a dim bound to
real state rather than a grey rectangle, and clicking empty stage still closes,
because the click reaches the canvas and misses every bot. The command palette
keeps *its* scrim, because that one really is modal.

### Turning the camera — right-drag

**Hold the right mouse button anywhere over the stage and drag** to turn the
scene, the way you would in Google Maps. Horizontal drag spins it, vertical drag
tilts from looking up at the arrangement from underneath to nearly top-down.
Release with the pointer still moving and it glides to a stop. Left-click still
selects a bot, and the browser context menu is suppressed over the canvas so the
gesture is usable at all.

The sign convention is direct manipulation — drag right and the scene follows your
hand to the right, which means the camera travels the other way. Two things follow
from the camera being a real turntable rather than a spun texture:

- **The fitted distance is re-solved from the live elevation.** The subject is not
  a flat plane: its depth projects through `sin(elevation)` but the bots' own
  vertical spread contributes through `cos`, and that term dominates at the low
  angle the scene is composed at. The vertical half-extent is read from the layout
  (`layoutVertical`) rather than being a constant — it was the room shell's fixed
  9 units, and it is now however far apart the bots actually are, which changes when
  one is added or removed.
- **The focus dolly shares the turntable's view axis.** Selecting a bot after
  turning dollies along wherever you are now, not back to the default heading.
- **Nothing is opaque and nothing is below the bots**, so the elevation range runs
  negative: −1.25 to +1.35 rad. The room clamped the bottom at +0.17 because any
  lower put the eye under opaque floorboards and the scene vanished behind them.
  Both ends still stop short of ±78°, where the view axis approaches the world
  up-vector `lookAt` uses and the frame rolls hard through the gimbal flip.

The ambient drift hands over on first use — the idle camera breathes on a slow
sine, which is right until someone takes hold of it. It comes back on **Reset
camera view** in `⌘K`, which is also the keyboard path: the canvas is
`aria-hidden` and never takes focus, so the gesture needs a command as its way
home. Under `prefers-reduced-motion` the drag still works — direct manipulation is
the user's own hand, not motion they did not ask for — but the release glide and
the reset tween are both dropped.

### The studio — deep space, and where the channels live now

This scene has been an orrery, then a workshop room, and is now deep space with
the bots floating in it. That churn is why some of the code has survived all three
untouched: the camera rig, the stage insets, the right-drag gesture and the focus
dolly were never about the backdrop. `DUST_VERT`/`DUST_FRAG` were written as a
starfield, spent one revision as airborne dust in a sunbeam, and are a starfield
again with the one-pixel sizing rule unretuned.

Every data channel is unchanged in meaning. Two moved house:

| Channel | Carrier |
| --- | --- |
| Time until next run | A **brass ring around each bot**, twelve ticks and a bright marker at twelve o'clock. Due now at the marker, overdue drifting past it. Was inlaid in the dock floor; a flat annulus disappears when the camera comes level with it in space, so it is a torus now |
| Cadence | **Depth zone** — daily nearest, weekly mid, on-demand furthest |
| Last run status | An **indicator panel** with the status colour *and* its glyph, seated in a `#1a1a19` bezel |
| Has it ever run | Body drained to grey, catchlights out, panel down to a trace |
| Run in progress | Panel pulse, and the machine's own idle animation speeds up |
| Cumulative tokens | **Physical output floating beside the bot** — paper, tape coils, crates, prints, envelopes |
| Relevance | **Conduits** between bots and an **aura** on each |

**Float height carries nothing, and is built so it cannot look like it does.** Each
bot's Y offset is derived from a hash of its id — stable, arbitrary, and
deliberately not from anything ordered like `orbitRadius`. Five bots at y=0 read as
five bots on an invisible floor, which is the reading the room was left to escape;
a viewer who assumed height meant something would be hunting for a pattern in a
hash, and there is not one.

**The comets are the one deliberate exception to "nothing is decoration", and the
reason is narrow.** They encode nothing. They are the liveness signal — the thing
that says the page is rendering and the poll is running, on a surface where every
real channel can legitimately sit still for a week. A weekly bot at rest with no
run in progress is a completely static frame, and a static frame is
indistinguishable from a hung one. That reasoning has a consequence which is
honoured: **under `prefers-reduced-motion` the comets are not slowed, they are not
built.** A liveness cue is exactly the unrequested motion that preference is about,
and one frozen streak across the sky reads as a scratch on the screen.

Every comet's position is computed on the GPU from three attributes and `uTime`, so
the whole system costs one uniform write per frame. The consequence to remember is
that the meshes must set `frustumCulled = false` — three computes bounds from the
`position` attribute, which is only the spawn point, so a comet halfway across the
sky would otherwise be culled against a sphere it left long ago.

**The dollhouse cull is gone and nothing replaced it.** The room needed a
`BackSide` box so near walls would vanish as the camera turned. There are no walls,
so every azimuth and elevation is a valid view with no visibility code at all —
and `ELEV_MIN` went from +0.17 rad (keep the eye above opaque floorboards) to
−1.25, so you can now look up at the arrangement from underneath.

**Status contrast is protected by construction, not by measurement.** Every status
panel is set into a bezel painted `#1a1a19`, which *is* `--surface`, the exact
background the figures in `design-dna.json` were measured against. The sky is never
a panel's local background, so every figure transfers unchanged. **Do not tint the
bezel to match the sky** — it is load-bearing. `NEBULA_FRAG` additionally holds a
hard luminance ceiling (`uCeiling`, a clamp on the final luminance so hue survives
it), which is belt and braces rather than the load-bearing part: a background that
can wash out the *bots* is still a bad background, and the cost of the guarantee is
one `min()`.

The renderer runs `NoToneMapping` for the same family of reason. A filmic curve
desaturates saturated highlights; `--status-failed` #d03b3b clears its requirement
at 3.62:1 with no margin to give away, and the figures describe the hex, not the
hex after a tone curve. Status panels are additionally `toneMapped: false`.

Nothing in `tokens.css` changed, so **no contrast figure needed recomputing**.

### Checking the scene actually renders

Two tools, because they catch different things and neither substitutes for the
other.

**`npm run test:scene`** asserts the arithmetic a 3D scene has no compiler for, in
Node with no WebGL: that nothing hangs inside disk-cleanup's hopper at any phase of
its idle animation, that the lid caps the dome rather than slicing it, that the
dial's hand agrees with its own ticks in all four quadrants, and that every bot id
builds including one with no persona modelled.

**`/scene-check.html`** is the runtime half, and it exists because the one thing
that only fails on a real driver is **GLSL compiling**. It mounts the studio
directly against synthetic bots covering every status role — no API, no token — and
prints the diagnosis *on the page*: whether `mount()` threw, every
`console.error` (which is how three reports a shader compile failure, with the
driver's full info log), and a live readback of the framebuffer as numbers. So one
screenshot answers "did it work" with no console to read.

```bash
chrome --headless=new --enable-unsafe-swiftshader --use-angle=swiftshader \
  --window-size=1600,900 --virtual-time-budget=12000 \
  --screenshot=scene.png http://127.0.0.1:5173/scene-check.html
```

Two flags matter for A/B work. `?aura=0` zeroes every graph degree, which turns the
auras off and changes nothing else — that is how you settle "is this halo a channel
or an artifact" instead of staring at it. And `--force-prefers-reduced-motion`
freezes the scene to one static frame, which is the only way two captures differ
*only* in what you changed: without it the bots have bobbed and the comets have
moved, and a pixel diff is dominated by animation phase. In that mode the
framebuffer sampler cannot work — the buffer is composited and cleared after the
single frame — so it says so rather than reporting a false black.

It is not in the production build: Vite builds `index.html` only unless a second
input is declared, and none is.

**This is how four real bugs were found**, none of which any test or type checker
could have caught: the aura's `side` being `BackSide` (which made its fresnel
evaluate to 1 everywhere and render a filled disc rather than a rim), a 4.3-unit
tower of crates next to a 1.7-unit robot, comets flying through the bot cluster,
and the front row clipped by a fit solver that framed the arrangement at its middle
instead of its nearest plane. Look at the thing.

### Screenshotting the real app

`node scripts/ui-shot.mjs --out <dir>` drives headless Chrome over the DevTools
Protocol and writes one PNG per bot, clipped to the open panel, plus an overview.
**No dependencies** — Node 22+ ships a global `WebSocket`, which is all a CDP client
needs.

It exists because `scene-check.html` deliberately bypasses the app, and the
interface is the half that talks to the server and gates on a token: `boot()` calls
`showGate()` and returns unless `localStorage['agency.token']` is set, so a plain
`--screenshot` of `/` captures a password prompt. The script does what a person
does — opens the page, seeds the token from `.env` via `Runtime.evaluate`, reloads,
clicks a bot row. **The token never goes in a URL**, for the same reason the API
takes it as a header.

Requires `npm run dev` to be running. Two gotchas are encoded in the script so
nobody rediscovers them: a wait predicate must evaluate to a **primitive**
(`returnByValue` cannot serialize a DOM node, so `until('document.querySelector(…)')`
spins forever while the element sits right there — there is now an assertion that
catches it), and page-side exceptions are forwarded to stderr, without which a
click that quietly does nothing gives you only a timeout pointing at the wrong
component.

**This is how the digest bug and the crushed ledger value were found.** Both looked
fine in the code.

### Relevance — the one new channel, and why it is allowed

Conduits and auras are exactly the kind of thing the "no decoration" rule exists
to keep out, so both are countable. `server/relevance.ts` derives them from the
Agency's own markdown: a `[[wikilink]]` scores 3, a markdown link into another
bot's tree scores 2, a bare mention of its id scores 1, each capped per file so
one wordy document cannot outweigh every real link.

- Conduit brightness is edge weight; its flow runs the way the heavier half of the
  reference runs.
- Aura intensity is the bot's degree, normalised against the busiest bot.
- **A bot nothing references gets no aura and no conduits.** Absence is a reading.

Three things are deliberately not scanned, and each was a bug first: the root
`CLAUDE.md` (its registry names every bot, so including it produced a
fully-connected graph carrying no information), any dot-directory
(`interface-design/.claude/skills/` is ten vendored third-party packs), and
`Agency/vault/` — which is *generated from this graph* and dense with wikilinks,
so scanning it would feed the output back into the input.

The scorer has 14 cases in `scripts/test-relevance.ts` (`npm run test:relevance`).
The one that matters most: `sam-research-weekly` must not count as a mention of
`sam-research`. Every bot's scheduled task is named `<bot>-<cadence>` and those
strings are all over the run reports, and `\b` cannot express this — it treats the
hyphen in a bot id as a boundary, so `\bsam-research\b` matches happily inside
`sam-research-weekly`.

### Per-bot panel themes, and the one thing they may not touch

Each bot's panel has its own typographic voice, accent, header treatment and
structural template, so opening one feels like opening *that bot's* instrument
rather than a generic drawer with a different name in it. `src/ui/theme.ts` holds
the role line and the sigil; `styles.css` holds the type.

| Bot | Voice |
| --- | --- |
| `sam-research` | Georgia serif, 62ch measure, double rules — a reading room |
| `finance-research` | Geist Mono throughout, tabular figures, perforated band — a ticker tape |
| `disk-cleanup` | Bahnschrift condensed caps, wide tracking, hatched band — a shipping manifest |
| `interface-design` | Geist Sans, tight tracking, air, accent bars for heads — a specimen sheet |
| `agency-repair` | Consolas, boxed section heads, hazard band — a service log |
| `media-bot` | Candara humanist, dotted band, soft rules — a switchboard slip |

**`--surface` (#1a1a19) stays exactly where it is on every theme.** Every status
contrast figure in `design-dna.json` is measured against that one hex, and
`--status-failed` #d03b3b clears its requirement at 3.62:1 with nothing to spare.
A theme that tinted the panel background would silently invalidate all five, and
the first to break would be the one that means "this bot is broken". Themes change
type, tracking, accent, header band and template; they do not change the surface or
the five status hexes.

The status chip additionally paints **its own** `--surface` background, so it
carries the background its figures were measured against wherever a theme puts it.
That is deliberately the same trick `scene/materials.ts` uses in 3D — a status
panel is seated in a bezel painted #1a1a19 so the sky behind the bot is never its
local background. Same problem, same answer, two very different renderers.

Fonts are **system stacks, not webfonts**. This server binds 127.0.0.1 and must
render with no network — the constraint that put Geist in `public/fonts/` rather
than on a CDN, and six themed webfonts would be six more files to vendor, license
and keep in step. Each stack is built from faces that ship with Windows 11 and ends
at Geist, so a machine without them degrades to the house face rather than to Times
New Roman.

`--bot-accent` is the **same hue** as that bot's model tint in `scene/bots3d.ts`
(`BOT_LOOK`), so the panel and the 3D character agree about who this is.

### The report digest

A run report's first six lines answer the only questions you open a panel to ask —
did it work, what did it do, what is it waiting on, what broke — and the detail
below them is usually twenty times longer. So `digestReport()` lifts that block out
and the panel renders it first, as a labelled grid with the status as a chip;
**Failed** and **Holding** carry an accent rule on their leading edge because those
are the two that mean somebody has to do something. The full report goes behind a
`Full report` disclosure.

**Three field forms are supported, because three are in use.** The bots do not
agree with each other, and each unsupported form meant that bot's reports silently
fell through to the fallback:

| Form | Written by |
| --- | --- |
| `**Did** — text` | `interface-design`, `finance-research` |
| `### Did` + prose below | `sam-research` |
| `**Did**` alone + list below | `agency-repair` |

If a report matches none of them the parser returns no fields and the panel renders
raw markdown exactly as before. That path matters: `agency-repair`'s 2026-08-03
report is an interactive write-up with no `**Status**` at all, and falling back is
*correct* for it.

`npm run test:digest` runs the parser over **every report on disk** as well as
synthetic fixtures, and asserts that any report declaring a status yields a digest.
That check is the whole reason this works: the first version broke on a blank line
— and every bot puts one between the heading and `**Status**` — so it produced zero
fields on **every real report in the repository** and shipped anyway, because the
fallback looks plausible. Three more form variants were then found one at a time by
the same check. Fixtures copied from real files, not invented.

### Standalone pages

`Open page` in the run picker opens the self-contained HTML the run rendered via
the Agency's [`live-artifact`](../.claude/skills/live-artifact/SKILL.md) skill — no
server, no token, no network, nothing to install. It is fetched with the token in a
header and opened as a Blob rather than linked to directly: a plain link sends no
custom header, so a `text/html` endpoint would need the token in the query string,
in history and in the referer, and this server's whole CSRF defence is that the
token is a header and never a cookie.

Pages only exist for runs since the skill was added; the button says so when there
is none rather than being hidden, because "this run produced no page" and "this
feature does not exist" are different facts.

### agency-repair's Requests view — the one write, and its fence

Every other view in this app reads. This one sends: a box in `agency-repair`'s
panel where you type what needs fixing, and the bot reads the queue at the start
of its next run.

It leads the panel, ahead of Reports, on the same `lead: true` opt-in `media-bot`
uses. For every other bot the report is the product; this is the one bot you open
in order to *tell it something*, so the box you type into is what should be in
front of you.

**This is the only endpoint that writes a new file into the Agency on a click,
and it is a deliberate carve-out from the rule stated on the vault endpoint —
which is still refused.** What earns it is how narrow the write is:

- **One hardcoded path**, `agency-repair/state/requests.json`, never derived from
  the request. There is no filename parameter to traverse.
- **Inert data.** The text is stored as a JSON string and read back as one. It
  never becomes a path, an argument or a command line; `spawn` is not involved.
- **Bounded** at 2,000 characters and 200 open requests, and the file is
  rewritten whole rather than appended to, so it cannot grow without limit.
- **Written through a rename**, so the bot never reads a half-written file, and
  through a promise chain, so two fast submissions cannot lose one another.

**A request is a note asking for something; it is not authority to do it.** Every
mechanical limit on `agency-repair` still binds when it acts on one — the Tier A
cap of 12 files and 400 lines, the deny rules keeping it out of sibling bots,
`.claude/` directories, `CLAUDE.md` files and lockfiles, and its PreToolUse
hooks. Something outside those is refused by the hook rather than by the model's
judgement, and the run reports the refusal. The UI is written to match: the
confirmation says the bot will *read* it, never that it will be fixed.

**Only a human closes a request.** The bot sets `pickedUpBy` and leaves `status`
alone, so the panel can tell a request nothing has looked at from one a run
considered and left open. A bot that closed its own tickets would be grading its
own homework.

### media-bot's Inbox view

The one panel whose default tab is **not** Reports. For this bot the live digest is
the product and the report is the record of how it was assembled; every other bot is
the other way round, which is why the ordering is a `lead: true` opt-in on the view
rather than a rule in the panel.

Two things it deliberately does not do. **Priority is not coloured** — same rule
the portfolio view spends its header on, since a red `important` badge would make
red mean two things. It is carried by the label, by position, and by an accent rule
in `--bot-accent`, which is by construction never a reserved hue. And **the rule
that classified each message is shown inline**, because a classifier you cannot
interrogate is one you will not trust, and one you do not trust you will not act on.

Instagram, TikTok and Snapchat are stated as having no personal notification API
every time, rather than rendering as three empty sections. An absent service that
looks like a service with nothing in it is the worst of the three readings.

**There is no staging or restore endpoint**, for the same reason there is no purge
endpoint: both touch a real mailbox. `python scripts\triage.py stage|restore` stays
at a terminal.

### Obsidian

`npm run vault` writes `Agency/vault/` — one Obsidian note per bot with frontmatter
properties and wikilinks, plus `Agency.canvas` in [JSON Canvas
1.0](https://jsoncanvas.org/spec/1.0/) laid out to mirror the room's floor plan.
The formats come from [kepano/obsidian-skills](https://github.com/kepano/obsidian-skills)
(MIT), vendored into `interface-design/.claude/skills/`.

Every bot's panel gains an **Obsidian** view listing its links with weights and
direction — the readable half of what the conduits show — and an `obsidian://`
link to the note. That link resolves only after the folder has been opened once as
a vault; the protocol handler cannot register one and the browser cannot report
whether it fired, so the panel says so rather than offering a link that looks
broken.

**There is no vault endpoint, deliberately.** It writes files outside
`dashboard/`, and the rule here is that a browser button may trigger a run,
restore a quarantine batch or revert a repair — all of which put things back or are
dry-run-gated — and may not write new files into the Agency on a click.
Regenerating a vault is harmless and idempotent, and it still stays at a terminal.

### P&L is not coloured

Green-up/red-down is the most conventional thing in finance and it is
unavailable here. `--status-ok` and `--status-failed` mean "the bot ran" and
"the bot broke"; a green `+2.3%` would make green mean two things on a surface
whose whole premise is that it means one. The sign and tabular numerals carry
the direction, which is what the "never colour alone" rule would have required
anyway. The equity curve separates account from benchmark by **weight and dash**
rather than hue — so no new hex entered the palette, and no contrast figure in
`design-dna.json` needed recomputing.

### Type

**Geist Sans + Geist Mono**, SIL OFL, self-hosted from `public/fonts/` as two
variable woff2 (141 KB total). Nothing is fetched at runtime — this server binds
loopback and must render with no network.

Mono is **structural**: labels, timestamps, counts, bot ids, status, section
heads, table headers — anything a machine emitted. Sans carries figures and
prose. Choosing which voice an element speaks in is the typographic equivalent
of choosing its motion register.

### Motion

Two motion registers, per `interface-design/design/motion-spec.md`:

- **Register A** — the studio. Expressive, continuous, now lit by real lights.
  Every visual property is bound to real state; see the channel table above.
- **Register B** — panels, reports, lists, buttons. Under 200 ms, `transform`
  and `opacity` only, and **zero** for anything keyboard-initiated.

Status is always glyph + label + colour, never colour alone — in the rail it is
also a 2px accent on the row's leading edge, which is redundant with the glyph
and the label rather than a substitute for either. Rows with no run status (a
quarantine batch) get a neutral rule, because borrowing a reserved status colour
to decorate one would make green mean two things.

The categorical palette used by the disk-composition bar was validated with the
dataviz skill's checker against this exact dark surface (worst adjacent CVD ΔE
8.4, normal-vision ΔE 19.8, all ≥ 3:1).

A sparkline is drawn only where there are **two or more** samples. A single
point has no scale and states no trend, so it renders as a speck that decodes to
nothing; the run count is in the row's meta line, which is where that fact
belongs.

`prefers-reduced-motion: reduce` renders the studio as a single static frame —
stopped, not slowed — and drops Register B to zero. Every per-frame lerp in the
scene snaps under that preference rather than easing: one frame of a 5%-per-frame
ease is 5% of the value, which is how the auras came to be invisible there before
this was noticed.

Press `⌘K` / `Ctrl+K` for the command palette. Everything is reachable without the
3D scene; if WebGL fails, the table view renders and the app stays fully usable.

## Layout

```
server/registry.ts   the hardcoded bot -> script allowlist. The security boundary.
server/index.ts      API. loopback bind, token header, no purge endpoint.
public/fonts/        Geist Sans + Geist Mono variable woff2, SIL OFL, self-hosted
src/scene/           three.js studio: space.ts, bots3d.ts, relevance.ts + custom GLSL
server/relevance.ts  the bot-to-bot reference graph, derived from markdown
scripts/build-vault.ts   npm run vault -> Agency/vault/ (Obsidian + JSON Canvas)
scripts/test-scene.ts    npm run test:scene -> geometry assertions, no WebGL needed
src/motion/          the two registers in code
src/ui/              rows, metrics, report panel, command palette, table view
src/ui/theme.ts      per-bot panel identity, and the run-report digest parser
src/tokens.css       GENERATED from interface-design/design/design-dna.json
```

The fonts are vendored into `public/`, not imported from `node_modules`. `geist`
is a **devDependency** — it is the licensed, versioned source the two woff2 files
were copied from, and nothing imports it at runtime. To update them, bump the
package and re-copy `dist/fonts/geist-sans/Geist-Variable.woff2` and
`dist/fonts/geist-mono/GeistMono-Variable.woff2`.
