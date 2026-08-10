# Interaction thesis — why an orrery

## The problem with a dashboard of cards

Four bots, each with a status, a schedule, a last run and a cost. The obvious
solution is four cards in a grid. It works, and it is completely forgettable —
and more importantly it throws away the one thing that actually structures this
data: **these bots are defined by time.** They run on schedules. The interesting
questions are all temporal — what ran, what is overdue, what is next, what has
never run at all.

A card grid renders "next run: Sat 08:00" as a string you have to parse. It gives
position no meaning, so position carries no information.

## The thesis

**Render the Agency as an orrery — a mechanical model of orbiting bodies — where
every visual property is bound to real state.**

This is the line between a data visualisation and a screensaver. Nothing in the
scene is chosen because it looks good in isolation; each property earns its place
by encoding something, and anything without a data source does not ship.

| Visual property | Bound to | Why it reads |
| --- | --- | --- |
| Orbital angle | Time until next scheduled run | Position becomes a clock. Overdue bots sit past the marker; you see "late" without reading a date. |
| Orbital radius | Schedule interval (daily inner, weekly outer, on-demand static) | Cadence becomes spatial. The busy bot is visibly the busy one. |
| Core colour | Last run status | Reserved status palette. |
| Core luminance | Has it ever run | `sam-research` has never run, so it renders **unlit** — a dead body in the system. That absence is currently buried in an empty ledger file; here it is the most conspicuous thing on screen. |
| Pulse | Run in progress | The only continuously animating element tied to a transient state, so motion means "happening now". |
| Ring particle density | Cumulative token spend | Cost is ambient. The root CLAUDE.md notes cron accumulates cost quietly; this makes it something you cannot help noticing. |

## Why this is legitimate and not decoration

Three tests, all of which it passes:

1. **Every channel decodes.** A viewer can state a fact from each property. If a
   property cannot be read back, it is ornament and gets cut.
2. **It degrades to a table.** The same data renders as a plain list, and that
   list is reachable — the visualisation is the pleasant path, not the only one.
3. **Colour never carries meaning alone.** Every body carries a glyph and a text
   label. A red core is reinforced by `✕ failed`, because status colour is
   reserved and must be redundantly encoded.

## The two registers, spatially

The orrery is **Register A** — expressive, continuous, shader-driven. It occupies
the background and the idle state.

Selecting a body moves to **Register B**: the camera settles, the ambient layer
dims to roughly 20% and slows, and a panel presents that bot's latest run report
as plain, immediately-legible text. No stagger, no reveal — a report you have to
wait for is a report that wastes your time.

The transition between them is the one place the two registers touch, and it is
deliberately short (180 ms) so it reads as focus rather than as a cutscene.

## What it must never become

- **A landing page.** There is no scroll-jacked narrative, no "hero moment". It
  opens showing state.
- **An excuse for latency.** The scene never delays data. If WebGL fails to
  initialise, the table view renders and the app is fully usable.
- **Colour-only.** Repeated because it is the easiest rule to lose during
  implementation.

## Keyboard path

The whole product is operable without the 3D scene: `⌘K` opens a command palette
listing every bot and action. Per the motion spec, **keyboard-initiated actions do
not animate** — the palette and its results appear instantly. Someone who lives in
the keyboard never has to wait for the orrery to finish moving.
