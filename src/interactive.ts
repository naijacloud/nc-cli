/**
 * Arrow-key selection, for the interactive navigator.
 *
 * terminal.ts covers questions with typed answers; this covers picking one item
 * out of a list, which is what every level of `naijacloud project` does. Both
 * write to **stderr** and read stdin in raw mode, for the same reason: stdout
 * belongs to command output, and a table printed from inside the navigator has
 * to stay pipeable.
 *
 * Nothing here works without a TTY, and that is checked by the caller before
 * the first frame — a menu drawn into a log file is noise nobody can answer.
 */

import process from "node:process";

import { CancelledError, isInteractive, write } from "./terminal.js";

/** ANSI: hide/show the cursor, so the caret does not sit on a moving row. */
const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";

/** Move up `n` lines and clear everything below, for an in-place redraw. */
function rewind(lines: number): string {
  return lines > 0 ? `\u001b[${lines}A\u001b[0J` : "\u001b[0J";
}

const DIM = "\u001b[2m";
const BOLD = "\u001b[1m";
const CYAN = "\u001b[36m";
const RESET = "\u001b[0m";

/** Colour is skipped when stderr is not a terminal, or when NO_COLOR is set. */
function colours(): boolean {
  return process.stderr.isTTY === true && !process.env["NO_COLOR"];
}

function paint(text: string, code: string): string {
  return colours() ? `${code}${text}${RESET}` : text;
}

export interface Choice<T> {
  /** Primary text. */
  label: string;
  /** Dimmed detail shown after the label — status, type, counts. */
  hint?: string;
  /** Returned when this row is picked. */
  value: T;
  /** Rendered but unselectable, for a capability that is not built yet. */
  disabled?: boolean;
  /** Visually separates this row from the one above it. */
  separated?: boolean;
}

/** How many rows to show at once before the list scrolls. */
const WINDOW = 12;

/** Does `choice` match a filter typed into the menu? Case-insensitive, label or hint. */
export function matchesFilter<T>(choice: Choice<T>, query: string): boolean {
  if (query === "") return true;
  const needle = query.toLowerCase();
  return (
    choice.label.toLowerCase().includes(needle) ||
    (choice.hint?.toLowerCase().includes(needle) ?? false)
  );
}

export interface SelectOptions {
  footer?: string;
  /**
   * Typing narrows the list instead of being read as a command. For long lists
   * (a GitHub account's repositories). Letters are then text, so q and j/k stop
   * being shortcuts: Escape cancels and the arrow keys move.
   */
  filter?: boolean;
}

/**
 * Presents `choices` and returns the picked value, or `null` if the user backed
 * out with q or Escape.
 *
 * Ctrl-C throws rather than returning null: quitting a menu and aborting the
 * program are different intentions, and only the caller knows whether backing
 * out means "go up a level" or "we are done".
 */
export async function select<T>(
  title: string,
  choices: readonly Choice<T>[],
  options: SelectOptions = {},
): Promise<T | null> {
  if (choices.length === 0) return null;

  const stdin = process.stdin;
  const filtering = options.filter === true;
  let query = "";
  // The rows on screen: every choice, or the ones matching the filter.
  let shown: readonly Choice<T>[] = choices;

  const firstEnabled = (): number => {
    const index = shown.findIndex((choice) => !choice.disabled);
    // An all-disabled list still renders, so the user can read *why* there is
    // nothing to pick, then back out.
    return index === -1 ? 0 : index;
  };
  let cursor = firstEnabled();
  let offset = 0;
  let drawn = 0;

  // Padded against every label, not just the visible ones, so the hint column
  // does not jump sideways as the list scrolls or narrows.
  const labelWidth = Math.max(...choices.map((choice) => choice.label.length));

  const frame = (): string => {
    // Keep the cursor inside the visible window before deciding what to show.
    if (cursor < offset) offset = cursor;
    if (cursor >= offset + WINDOW) offset = cursor - WINDOW + 1;

    const visible = shown.slice(offset, offset + WINDOW);
    const lines = [paint(title, BOLD)];
    if (filtering) lines.push(`  ${paint("Filter:", DIM)} ${query}`);

    for (const [index, choice] of visible.entries()) {
      const absolute = offset + index;
      const active = absolute === cursor;
      const marker = active ? "❯" : " ";

      // Pad before colouring: the escape codes have no width on screen but
      // would be counted by padEnd, shifting every coloured row left.
      const padded = choice.hint ? choice.label.padEnd(labelWidth) : choice.label;
      let label = padded;
      if (choice.disabled) label = paint(padded, DIM);
      else if (active) label = paint(padded, CYAN);

      const hint = choice.hint ? `  ${paint(choice.hint, DIM)}` : "";
      // Separators mark groups in the full list; in a filtered one they would
      // fall between unrelated rows.
      if (choice.separated && query === "") lines.push("");
      lines.push(`${marker} ${label}${hint}`);
    }

    if (shown.length === 0) lines.push(paint(`  No match for '${query}'.`, DIM));
    if (shown.length > WINDOW) {
      lines.push(paint(`  ${cursor + 1}/${shown.length}`, DIM));
    }
    lines.push(paint(options.footer ?? "↑↓ move · ↵ select · q back", DIM));

    return `${lines.join("\n")}\n`;
  };

  const render = (): void => {
    const text = frame();
    write(rewind(drawn) + text);
    drawn = text.split("\n").length - 1;
  };

  /** Advances the cursor past disabled rows, wrapping at both ends. */
  const move = (step: number): void => {
    if (shown.length === 0) return;
    for (let attempt = 0; attempt < shown.length; attempt += 1) {
      cursor = (cursor + step + shown.length) % shown.length;
      if (!shown[cursor]!.disabled) return;
    }
  };

  const refilter = (): void => {
    shown = choices.filter((choice) => matchesFilter(choice, query));
    cursor = firstEnabled();
    offset = 0;
  };

  const previousRaw = stdin.isRaw ?? false;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  write(HIDE_CURSOR);
  render();

  return await new Promise<T | null>((resolve, reject) => {
    const cleanup = (): void => {
      stdin.setRawMode(previousRaw);
      stdin.pause();
      stdin.removeListener("data", onData);
      // Wipe the menu on the way out: what the selection *produced* is the
      // useful thing to leave on screen, not the list it came from.
      write(rewind(drawn) + SHOW_CURSOR);
    };

    const onData = (chunk: string): void => {
      switch (chunk) {
        case "\u001b[A": // Up
          move(-1);
          render();
          return;
        case "\u001b[B": // Down
          move(1);
          render();
          return;
        case "\r":
        case "\n": {
          const choice = shown[cursor];
          if (!choice || choice.disabled) return;
          cleanup();
          resolve(choice.value);
          return;
        }
        case "\u001b": // Escape
          cleanup();
          resolve(null);
          return;
        case "\u0003": // Ctrl-C
          cleanup();
          reject(new CancelledError());
          return;
        default:
          break;
      }

      if (filtering) {
        if (chunk === "\u007f" || chunk === "\b") {
          if (query === "") return;
          query = query.slice(0, -1);
        } else if (!chunk.startsWith("\u001b") && [...chunk].every((char) => char >= " ")) {
          // Typed or pasted text. Other escape sequences (left/right, function
          // keys) are ignored rather than landing in the filter as garbage.
          query += chunk;
        } else {
          return;
        }
        refilter();
        render();
        return;
      }

      switch (chunk) {
        case "k":
          move(-1);
          render();
          return;
        case "j":
          move(1);
          render();
          return;
        case "q":
          cleanup();
          resolve(null);
          return;
        default:
          return;
      }
    };

    stdin.on("data", onData);
  });
}

/**
 * Fails before the first frame when there is no terminal to draw on.
 * `alternative` is the non-interactive command that does the same job.
 */
export function requireInteractive(what: string, alternative: string): void {
  if (isInteractive()) return;
  throw new Error(
    `${what} needs an interactive terminal. Use the direct command instead:\n  ${alternative}`,
  );
}

/** A heading printed above whatever a navigator screen renders. */
export function heading(path: string, detail?: string): void {
  write(`\n${paint(path, BOLD)}${detail ? `  ${paint(detail, DIM)}` : ""}\n\n`);
}

/** Waits for any key, so a rendered screen is not swallowed by the next menu. */
export async function pause(message = "↵ continue"): Promise<void> {
  const stdin = process.stdin;
  const previousRaw = stdin.isRaw ?? false;

  write(`\n${paint(message, DIM)}`);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: string): void => {
      stdin.setRawMode(previousRaw);
      stdin.pause();
      stdin.removeListener("data", onData);
      write(`\r\u001b[0J`);
      if (chunk === "\u0003") reject(new CancelledError());
      else resolve();
    };
    stdin.on("data", onData);
  });
}
