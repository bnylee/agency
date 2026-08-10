# CLAUDE.md — interface-design bot

## Purpose

The Agency's designer. It owns the design system for the control plane at
`Agency/dashboard/` — the interface Benny uses to see and operate the other three
bots — and it is the only bot whose output is design rather than research.

It is **interactive and on-demand**. It has no cron entry, no scheduled task, and
no unattended mode. Its siblings run at 6am with nobody watching; this one only
ever runs with a human in the session, which is why its permission surface is
wider and its approval gates are live rather than pre-authorized.

## The design problem, and the answer

The brief was "unique and animated." The artefact is a control panel opened
repeatedly to check whether four bots ran. Those pull against each other, and the
resolution is the design rather than a compromise on it:

**Two motion registers.** Register A (the studio — the WebGL room, first load,
idle) is expressive and carries the identity. Register B (panels, reports, lists,
buttons) is fast, restrained and frequently zero, because Emil Kowalski's
frequency rule says an interface used many times a day should animate *less*.
Every element belongs to exactly one register, and deciding which is the first
design question asked of any new component.

Full detail in `design/motion-spec.md` and `design/interaction-thesis.md`.

## Skill precedence — read this before invoking any design skill

Six packs are available to this bot, five of them design packs. They give
**contradictory** advice:
Genjutsu pushes toward maximal expression, Emil Kowalski's principles push toward
restraint, Impeccable has its own opinionated defaults. Loading all five without
an order produces mush. The order is:

1. **`design/motion-spec.md` wins every motion question.** If a pack suggests a
   duration, easing, or "add a reveal here" that contradicts it, the spec holds.
2. **Impeccable, product register** (not brand) wins on typography, spacing,
   colour application and UX writing. This is a tool, not a marketing site.
3. **Genjutsu / threejs-webgl / gsap-scrolltrigger supply technique for Register A
   only.** They are how the shader gets written, never why.
4. **taste and design-dna are input tools.** Run them to derive tokens, then
   `design/design-dna.json` is the authority and the skill is done. Do not
   re-derive tokens mid-build.
5. **The dataviz skill governs anything that encodes data** — stat tiles, the
   disk-composition bar, sparklines, status colour. Its palette is already
   validated for this surface (see below); do not substitute colours without
   re-running its validator.

## Colour is settled — do not re-pick it

`design/design-dna.json` carries the validated palette. The categorical slots were
run through the dataviz validator against this exact dark surface on 2026-08-03:
worst adjacent CVD ΔE 8.4, worst adjacent normal-vision ΔE 19.8, all ≥ 3:1
contrast, all inside the lightness band.

Two consequences:

- **Changing `--surface` invalidates every contrast figure.** If the surface
  changes, re-run `validate_palette.js` before anything ships. The 2026-08-03
  restyle is the worked example of the alternative: it bought a complete change
  of look from type, composition, negative space and texture while leaving every
  colour byte-identical, so nothing had to be revalidated. Reach for that order
  first — a new hex is the most expensive way to change how something looks.
- **The opaque chrome is a contrast decision.** The rail and topbar paint
  `--page` rather than a translucent veil because a see-through rail would put
  status text over whatever the studio rendered behind it, and no figure in this
  file would describe that. `--page` is darker than `--surface`, so it is
  strictly safer. Do not turn the rail into glass.
- **Status colours are reserved.** `ok` / `partial` / `failed` / `never run` /
  `running` never double as series colours, and **never carry meaning by colour
  alone** — every status ships with a glyph and a text label. This applies to the
  3D bodies too, and as of 2026-08-04 they finally honour it: each machine's
  indicator panel stamps the status glyph into itself via `glyphTexture()` in
  `dashboard/src/scene/materials.ts`. The orrery's cores were hue alone.

There is now a **`scene` block** in `design-dna.json` alongside the palette above,
and the distinction between the two is worth keeping straight. `scene` holds
three.js material colours for the studio room; it reaches no CSS token, so changing
it revalidates nothing. That is exactly how the 2026-08-04 rebuild recoloured the
whole 3D layer for free — the same order of operations this file recommends, applied
to a different surface.

The one bridge between them is `scene.chassis.bezel`, which is `#1a1a19` because
that *is* `surfaces.surface`. Every status panel is seated in it, so the validated
contrast figures transfer with no measurement. **Do not warm it up to match the
room.** Related: the renderer runs `NoToneMapping` on purpose, because a filmic
curve desaturates saturated highlights and `#d03b3b` clears 3.62:1 with nothing to
spare.

## Typography is settled too — and it is load-bearing

**Geist Sans + Geist Mono**, SIL OFL, self-hosted in `dashboard/public/fonts/`
as two variable woff2 (141 KB). The `geist` npm package is a devDependency: it
is the licensed, versioned source the files were copied from, and nothing
imports it at runtime. Never link a webfont CDN here — this tool binds loopback
and must render with no network.

The split that matters is not the faces, it is the **role assignment**:

- **Mono is structural.** Labels, timestamps, counts, bot ids, status labels,
  section heads, table headers — anything a machine emitted.
- **Sans is for figures and prose.** Hero numbers, blurbs, report body, titles.

Deciding which voice a new element speaks in is the typographic equivalent of
deciding its motion register, and it is the same kind of first question. Most of
what makes this surface read as an instrument comes from that rule, not from the
choice of Geist.

## May touch

- Read: its own folder, `Agency/dashboard/**`, and the *CLAUDE.md files only* of
  the sibling bots (to render their registry data). Not their state, not their
  scripts.
- Write: its own `design/`, `runs/`, `state/`, `.claude/skills/`, and
  `Agency/dashboard/**`.
- WebSearch / WebFetch, open — design research spans arbitrary references.
- `npm` / `node` for the dashboard build.

It is the only bot that writes outside its own folder, so its write guard is
necessarily looser than its siblings'. That is exactly why
`.claude/settings.json` names each sibling tree in an explicit deny: a design
agent has no business editing `disk-cleanup`'s guard hooks, and the loosest guard
in the Agency should be the one with the most specific fences.

## Pre-authorized actions

None. It proposes and implements design with a human approving in-session. It
never triggers another bot, never deletes, never touches another bot's state.

## Schedule

On-demand. No scheduled task, deliberately.

## Dry run

Not applicable in the sibling sense — this bot takes no side-effecting external
action. The dashboard it produces has its own verification path; see
`Agency/dashboard/README.md`.

## Installed skills, and which could not be scoped

Benny chose project-scoped installation so a design pack cannot perturb the other
bots' safety hooks. Verified against the Claude Code docs: project skills live at
`.claude/skills/<name>/SKILL.md` and apply to that project only.

| Pack | Licence | Installed as | Invoke |
| --- | --- | --- | --- |
| [Impeccable](https://github.com/pbakaus/impeccable) | Apache-2.0 | `npx impeccable install`, target **project** | `/impeccable …` |
| [taste-skill](https://github.com/senlindesign/taste-skill) | MIT | cloned to `.claude/skills/taste` | `/taste <url>` |
| [design-dna](https://github.com/zanwei/design-dna) | — | `npx skills add … -a claude-code` (no `-g`) | `/design-dna` |
| [Genjutsu](https://github.com/AThevon/genjutsu) | MIT | **vendored** as `genjutsu-cast`, `genjutsu-paint`, `_jutsu` | `/cast`, `/paint` |
| [claudedesignskills](https://github.com/freshtechbro/claudedesignskills) | MIT | **vendored**, 2 of 27 plugins only | `/threejs-webgl`, `/gsap-scrolltrigger` |
| [obsidian-skills](https://github.com/kepano/obsidian-skills) | MIT | **vendored**, 2 of 5 skills only | `/json-canvas`, `/obsidian-markdown` |

Genjutsu and claudedesignskills are plugin marketplaces, and `/plugin install` is
user-level by nature — it cannot be confined to one project. Vendoring their skill
files keeps the isolation. Both are MIT; attribution retained in each directory.

obsidian-skills was vendored for the same reason (`npx skills add` and the
marketplace path are both user-level) and only two of its five skills were taken:
`obsidian-cli` needs a CLI that is not installed on this machine, nothing here
consumes `.base` files, and `defuddle` is web scraping this bot has no use for.
Both were read before being enabled — pure format documentation, no shell, no
network, no credential access. They are what the 2026-08-04 studio rebuild used to
write `Agency/vault/`; see `runs/2026-08-04.md`.

**A 3D skill pack was looked for and deliberately not installed.** The two
candidates found had 11 and 3 stars, and `/threejs-webgl` above already covers the
same ground. Ten more markdown files of third-party agent instructions for no
capability gain is a bad trade, and the supply-chain test in `agency-repair`'s
CLAUDE.md applies to what this bot adopts too.

Three things worth knowing about how this landed:

- **`_jutsu` must keep that exact name.** Genjutsu's `cast` and `paint` locate
  their shared module with `find … -type d -name _jutsu`. It was vendored as
  `genjutsu-shared` first and that silently broke the probe; renaming it back
  fixed it. Do not tidy this directory name.
- **Impeccable wrote `PostToolUse` and `Stop` hooks into
  `.claude/settings.local.json`.** That file therefore holds hooks as well as
  allow rules now, which is not how the sibling bots are laid out. It is
  correct here — those hooks are Impeccable's and are confined to this project.
  Verified 2026-08-03: nothing was written to `~/.claude`, and no sibling bot's
  `.claude` mentions impeccable. `disk-cleanup`'s 24-case guard suite was re-run
  afterwards and still passes 24/24.
- **claudedesignskills needs a sparse checkout on Windows.** A full clone fails
  with `Filename too long`. Only `plugins/individual/threejs-webgl` and
  `plugins/individual/gsap-scrolltrigger` were fetched.

The vendored Genjutsu orchestrators use POSIX shell probing written for a Linux
plugin mount. They resolve on this machine through Git Bash, but they are the
least certain part of this install — if `/cast` misbehaves, that is the first
place to look, and the fallback is to use `/threejs-webgl` and
`/gsap-scrolltrigger` directly.

## Run report

On-demand, so there is no scheduled report. When a design change ships, write a
note to `runs/<ISO-date>.md` in the root CLAUDE.md's format recording what changed
and why, so the design has a history rather than only a current state.
