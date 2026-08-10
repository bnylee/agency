# Motion spec — Agency control plane

**This file wins every motion argument.** If a design skill pack suggests something
that contradicts a number here, the number here holds. The packs supply technique;
this file supplies the budget.

Source: Emil Kowalski, [animations.dev](https://animations.dev/) — author of Sonner
and Vaul, design engineer at Linear, previously Vercel.

---

## The central problem

The request was "unique and animated." The thing being built is a control panel
Benny will open repeatedly to check whether four bots ran. Those two pull in
opposite directions, and the resolution is the design, not a compromise on it.

Kowalski's **frequency rule**: the more often an interface is used, the less it
should animate. Keyboard-initiated actions should never animate. A tool used
constantly benefits from *zero* animation. An animation that delights on first
sight is a tax on the four-hundredth.

So the product has **two motion registers**, and every element belongs to exactly
one. Deciding which register something is in is the first design question, not an
afterthought.

## Register A — Ambient

**Where:** the orrery (WebGL background), first-load sequence, idle state.
**Budget:** expressive. This is where "unique" lives.

- Continuous motion is allowed here and only here.
- Custom GLSL, not stock materials.
- Runs at 60fps or it gets simplified until it does.
- Never blocks interaction. The user can click through it at any moment.
- Pauses entirely when the tab is hidden (`visibilitychange`) — a background tab
  spinning a GPU is a bug, not a flourish.

## Register B — Control

**Where:** panels, report text, lists, buttons, triggers, status chips — anything
carrying information or accepting input.
**Budget:** restrained, fast, and frequently zero.

| Case | Duration | Easing |
| --- | --- | --- |
| Hover / press feedback | 100–150 ms | `ease-out` |
| Panel enter | 180 ms | `ease-out` |
| Panel exit | 150 ms | `ease-in` |
| Element moving position | 200 ms | `ease-in-out` |
| Sheet / drawer | 500 ms | `cubic-bezier(0.32, 0.72, 0, 1)` |
| Clip-path reveal | 300 ms | `cubic-bezier(0.77, 0, 0.175, 1)` |
| **Keyboard-initiated anything** | **0 ms** | none |

**180 ms reads as more responsive than 400 ms.** Nothing in Register B exceeds
300 ms except the sheet, which is a large-travel surface where the longer curve
reads as physical rather than sluggish.

## Hard rules

- **Animate `transform` and `opacity` only.** Never `width`, `height`, `padding`,
  `margin`, `top`, `left` — they trigger layout and drop frames.
- **Press state is `scale(0.97)`.** Not 0.9, not 0.95.
- **Entrances scale from `0.9`, never from `0`.** Scaling from zero reads as a
  cartoon; from 0.9 it reads as arriving.
- **Avoid the built-in CSS keywords** `ease` and `ease-in-out` for anything
  expressive — they are weak. Use explicit `cubic-bezier`.
- **Dropdowns and popovers are origin-aware** — `transform-origin` set to the
  edge they belong to, so they grow out of their trigger.
- **Repeated tooltips are instant.** First one animates; subsequent ones within
  the session appear at 0 ms.

## Things that must NOT animate here

Concrete to this product, not generic advice:

- **Status changes.** A bot going `ok → failed` must be instantly legible. Do not
  cross-fade it, do not animate the colour. Failure should hit immediately.
- **The report reader.** Text that appears with a stagger is text you have to wait
  to read. It renders at once.
- **Anything triggered by keyboard** — the command palette, its results, focus
  movement.
- **Numbers that update on poll.** No count-up tweens on a live value; it makes a
  static number look like it is changing.

## Reduced motion

`@media (prefers-reduced-motion: reduce)`:

- Register A renders **one static frame** and stops. Not "slower" — stopped.
- Register B drops to 0 ms across the board. Everything still works; nothing moves.
- This is a first-class path, tested, not a fallback that nobody looks at.

## Colour is not motion, but the same restraint applies

Status colour comes from the reserved status palette and is **never carried by
colour alone** — every status ships with a glyph and a text label. This applies to
the 3D bodies too: a red core is not sufficient, the label says `failed`.
