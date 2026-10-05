/**
 * Terminal prompts.
 *
 * Everything here writes to **stderr** and reads from stdin, so stdout stays
 * clean for command output that a caller may be piping into a file or `jq`.
 *
 * Nothing prompts without a TTY. A CI run that reaches a question has no way to
 * answer it, and blocking forever on stdin is the worst possible failure — so
 * `requireTty` turns that into an error naming the flag that would have
 * supplied the answer.
 */

import process from "node:process";

/** Prompts and progress go to stderr; stdout belongs to command output. */
export function write(text: string): void {
  process.stderr.write(text);
}

/**
 * The user backed out of a prompt (q, Escape or Ctrl-C).
 *
 * Its own class so the entrypoint can exit quietly: backing out is an answer,
 * not a failure, and printing "Error: Cancelled." for it reads like something
 * broke. The message is kept as "Cancelled." for callers that still compare it.
 */
export class CancelledError extends Error {
  constructor() {
    super("Cancelled.");
    this.name = "CancelledError";
  }
}

/** Whether `error` is the user backing out rather than something failing. */
export function isCancelled(error: unknown): boolean {
  return (
    error instanceof CancelledError ||
    (error instanceof Error && error.message === "Cancelled.")
  );
}

export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stderr.isTTY === true;
}

/**
 * Fails with an actionable message when there is nobody to answer a question.
 * `alternatives` are the flags that make the run non-interactive.
 */
export function requireTty(what: string, alternatives: string[]): void {
  if (isInteractive()) return;
  throw new Error(
    `${what} needs an interactive terminal. Pass it explicitly instead:\n` +
      alternatives.map((line) => `  ${line}`).join("\n"),
  );
}

/**
 * Reads one line in raw mode, so a hidden prompt can suppress the echo and
 * backspace works the way a terminal user expects.
 */
export async function promptLine(question: string, { hidden = false } = {}): Promise<string> {
  const stdin = process.stdin;
  write(question);

  return await new Promise<string>((resolve, reject) => {
    const chunks: string[] = [];
    const previousRaw = stdin.isRaw ?? false;

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const cleanup = (): void => {
      stdin.setRawMode(previousRaw);
      stdin.pause();
      stdin.removeListener("data", onData);
    };

    const onData = (chunk: string): void => {
      for (const char of chunk) {
        switch (char) {
          case "\r":
          case "\n":
            write("\n");
            cleanup();
            resolve(chunks.join(""));
            return;
          case "\u0003": // Ctrl-C
            write("\n");
            cleanup();
            reject(new CancelledError());
            return;
          case "\u007f": // Backspace
          case "\b":
            if (chunks.length > 0) {
              chunks.pop();
              if (!hidden) write("\b \b");
            }
            break;
          default:
            // Ignore other control characters.
            if (char < " ") break;
            chunks.push(char);
            if (!hidden) write(char);
            break;
        }
      }
    };

    stdin.on("data", onData);
  });
}

/**
 * Asks for a value, showing the default in brackets. Enter accepts the default,
 * which is what makes the first-run flow mostly keypresses.
 */
export async function promptWithDefault(
  label: string,
  fallback: string,
  hint?: string,
): Promise<string> {
  const suffix = hint ? ` (${hint})` : "";
  const answer = await promptLine(`${label}${suffix} [${fallback}]: `);
  return answer.trim() || fallback;
}

/** Asks a yes/no question. Anything but an explicit y/n keeps the default. */
export async function promptYesNo(
  label: string,
  fallback: boolean,
  hint?: string,
): Promise<boolean> {
  const suffix = hint ? ` (${hint})` : "";
  const answer = (await promptLine(`${label}${suffix} [${fallback ? "Y/n" : "y/N"}]: `))
    .trim()
    .toLowerCase();
  if (answer === "y" || answer === "yes") return true;
  if (answer === "n" || answer === "no") return false;
  return fallback;
}
