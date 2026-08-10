import { el } from "./components";

export interface Command {
  label: string;
  kind: string;
  run: () => void;
}

/**
 * Command palette. Opened by ⌘K / Ctrl+K.
 *
 * This is keyboard-initiated, so per the motion spec it does **not animate** —
 * no fade, no scale, no stagger on the results. Someone who lives in the
 * keyboard should never wait for the interface to catch up. That is the whole
 * reason this file imports nothing from gsap.
 */
export function mountPalette(getCommands: () => Command[]): { open: () => void; close: () => void } {
  const root = document.getElementById("cmd-root")!;
  let commands: Command[] = [];
  let filtered: Command[] = [];
  let cursor = 0;

  const input = el("input", { type: "text", placeholder: "Type a bot or an action…", "aria-label": "Command palette" });
  const list = el("ul", { role: "listbox" });
  const box = el("div", { class: "cmd" }, input, list);
  const scrim = el("div", { class: "cmd-scrim" }, box);

  scrim.addEventListener("pointerdown", (e) => { if (e.target === scrim) close(); });

  function paint() {
    const q = input.value.trim().toLowerCase();
    filtered = q ? commands.filter((c) => c.label.toLowerCase().includes(q)) : commands;
    if (cursor >= filtered.length) cursor = Math.max(0, filtered.length - 1);
    list.replaceChildren(
      ...filtered.map((c, i) =>
        el("li", { role: "option", "aria-selected": String(i === cursor) },
          el("span", {}, c.label),
          el("span", { class: "kind" }, c.kind))),
    );
    for (const [i, node] of [...list.children].entries()) {
      node.addEventListener("pointerdown", () => { filtered[i]?.run(); close(); });
    }
  }

  function open() {
    commands = getCommands();
    cursor = 0;
    input.value = "";
    root.hidden = false;
    root.replaceChildren(scrim);
    paint();
    input.focus();
  }

  function close() {
    root.hidden = true;
    root.replaceChildren();
  }

  input.addEventListener("input", paint);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); cursor = Math.min(cursor + 1, filtered.length - 1); paint(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); cursor = Math.max(cursor - 1, 0); paint(); }
    else if (e.key === "Enter") { e.preventDefault(); filtered[cursor]?.run(); close(); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  });

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      root.hidden ? open() : close();
    }
  });

  return { open, close };
}
