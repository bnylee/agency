/**
 * The two motion registers, in code.
 *
 * Authoritative spec: interface-design/design/motion-spec.md. Every duration and
 * easing here is a copy of a number decided there; if they disagree, the spec is
 * right and this file is stale.
 *
 * Register A — ambient. Expressive, continuous, the studio.
 * Register B — control. Fast, restrained, frequently zero.
 *
 * The point of putting them in one file is that adding motion forces you to name
 * which register it belongs to, which is the design question the spec says to ask
 * first.
 */
import gsap from "gsap";

export const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

export const D = {
  instant: 0,
  feedback: 0.12,
  enter: 0.18,
  exit: 0.15,
  move: 0.2,
  sheet: 0.5,
} as const;

export const E = {
  out: "power3.out",
  in: "power3.in",
  inOut: "power2.inOut",
  // cubic-bezier(0.32, 0.72, 0, 1) — the iOS sheet curve.
  sheet: "cubic-bezier(0.32, 0.72, 0, 1)",
} as const;

/** Register B duration, collapsed to zero under reduced motion. */
export function b(seconds: number): number {
  return reduced.matches ? 0 : seconds;
}

/**
 * Panel enter. Scales from 0.9 and never from 0 — from zero it reads as a
 * cartoon, from 0.9 it reads as arriving.
 */
export function enterPanel(el: HTMLElement): gsap.core.Tween {
  return gsap.fromTo(
    el,
    { opacity: 0, scale: 0.9, y: 8 },
    { opacity: 1, scale: 1, y: 0, duration: b(D.enter), ease: E.out, clearProps: "transform" },
  );
}

export function exitPanel(el: HTMLElement, onDone?: () => void): gsap.core.Tween {
  return gsap.to(el, { opacity: 0, scale: 0.96, duration: b(D.exit), ease: E.in, onComplete: onDone });
}

/**
 * Press feedback. scale(0.97) exactly — the spec's number, not an approximation.
 * Applied on pointer only; keyboard activation gets no animation at all, which
 * is why this is wired to pointerdown rather than to a generic activate event.
 */
export function attachPress(el: HTMLElement): void {
  const down = () => gsap.to(el, { scale: 0.97, duration: b(D.feedback), ease: E.out });
  const up = () => gsap.to(el, { scale: 1, duration: b(D.feedback), ease: E.out });
  el.addEventListener("pointerdown", down);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointerleave", up);
  el.addEventListener("pointercancel", up);
}

/**
 * Deliberately absent from this file: any helper that animates a status change,
 * a number, or report text. The spec forbids all three — a failure must land
 * instantly, and text you have to wait to read is text that wastes your time.
 * If you find yourself wanting one, re-read the spec rather than adding it here.
 */
