/**
 * `naijacloud logs [service] [-f]` — a service's runtime logs: what the running
 * app prints, as opposed to `deployments logs <id>`, which is a build's output.
 *
 * The lines come from the control plane's log gateway (see
 * ../api/logs-socket.ts), the same stream the dashboard's Logs tab shows.
 * Without --follow it prints the most recent lines and exits; with it, it keeps
 * printing as the app writes until Ctrl-C, reconnecting on its own when the
 * link drops and skipping the lines it already printed.
 */

import process from "node:process";

import { NaijaCloudError, NotLoggedInError, requestToken } from "../api/index.js";
import { LogsSocket } from "../api/logs-socket.js";
import type { JoinAck, OlderLogsAck, RuntimeLogLine, RuntimeLogStatus } from "../api/logs-socket.js";
import { programName } from "../program-name.js";
import { write } from "../terminal.js";
import { requireService } from "./resolve.js";

/** Lines printed without --limit. */
export const DEFAULT_LINES = 100;

/** The most one request returns (the gateway's own cap). */
const MAX_PAGE = 500;

/** Without --follow and without range support: how long a quiet stream counts as "done". */
const QUIET_MS = 1_500;
const COLLECT_MAX_MS = 10_000;

/** Reconnect backoff when a followed stream drops. */
const RETRY_MAX_MS = 30_000;

/** How many printed lines are remembered to drop a replayed backlog. */
const SEEN_MAX = 2_000;

export interface LogsOptions {
  service: string | undefined;
  project?: string | undefined;
  follow: boolean;
  limit: number | undefined;
  timestamps: boolean;
  json: boolean;
  /** Stops --follow, as Ctrl-C does. */
  signal?: AbortSignal | undefined;
  /** Where the lines go; stdout unless given. */
  out?: ((text: string) => void) | undefined;
}

/** Workspace API keys (`nc_live_…`) — accepted by `/v1`, not by the log gateway. */
function isApiKey(token: string): boolean {
  return /^nc_(live|test)_/.test(token);
}

/** What a line is known by, to drop a copy of it the gateway sends again. */
export function lineKey(line: RuntimeLogLine): string {
  return `${line.ts ?? line.at}\u0000${line.stream}\u0000${line.line}`;
}

/** One line as printed: the app's text, after its time with --timestamps. */
export function formatLine(line: RuntimeLogLine, timestamps: boolean): string {
  const text = line.line.replace(/\r?\n$/, "");
  return timestamps ? `${line.at} ${text}\n` : `${text}\n`;
}

/**
 * Remembers what was printed, so a reconnect's backlog (up to 200 recent lines,
 * replayed on every join) does not print twice.
 */
export class SeenLines {
  private readonly keys = new Set<string>();

  /** True the first time a line is offered, false for a copy. */
  add(line: RuntimeLogLine): boolean {
    const key = lineKey(line);
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    if (this.keys.size > SEEN_MAX) {
      const oldest = this.keys.values().next().value;
      if (oldest !== undefined) this.keys.delete(oldest);
    }
    return true;
  }
}

/** The bearer token the gateway will take, or an error saying why not. */
function gatewayToken(): string {
  const resolved = requestToken();
  if (!resolved) throw new NotLoggedInError();
  if (isApiKey(resolved.token)) {
    throw new NaijaCloudError(
      "Runtime logs stream from the dashboard's log gateway, which takes a login session, " +
        `not a workspace API key. Run '${programName()} login' with your email and password, ` +
        "or read the logs in the dashboard.",
      { code: "API_KEY_NOT_ACCEPTED" },
    );
  }
  return resolved.token;
}

/** A gateway refusal, in the CLI's words. */
function refused(error: string | undefined, serviceId: string): Error {
  const message = error?.trim() || "the log stream refused the request";
  if (/unauthori[sz]ed|session ended/i.test(message)) {
    return new NotLoggedInError(
      "NaijaCloud rejected the credentials for the log stream (they may have expired). " +
        `Run '${programName()} login' again.`,
    );
  }
  if (/only available for web services/i.test(message)) {
    return new NaijaCloudError(
      `Service ${serviceId} has no runtime logs: only web services do. ` +
        `For a build's output, use '${programName()} deployments logs <id>'.`,
    );
  }
  return new NaijaCloudError(`Cannot read the logs of service ${serviceId}: ${message}`);
}

/**
 * The gateway checks the session asynchronously after it accepts the socket,
 * so a request sent the instant the socket opens can be told "unauthorized"
 * by a session that is in fact fine. Ask again, briefly, before believing it.
 */
async function withAuthRetry<T extends { ok: boolean; error?: string }>(
  socket: LogsSocket,
  ask: () => Promise<T>,
): Promise<T> {
  let answer = await ask();
  for (let attempt = 0; attempt < 3 && !answer.ok && /^unauthori[sz]ed$/i.test(answer.error ?? ""); attempt += 1) {
    const closed = await Promise.race([
      socket.closed.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 400 * (attempt + 1))),
    ]);
    if (closed) break;
    answer = await ask();
  }
  return answer;
}

/** Opens a socket and records the gateway's own error messages on it. */
async function open(token: string): Promise<{ socket: LogsSocket; lastError: () => string | undefined }> {
  const socket = new LogsSocket(token);
  let lastError: string | undefined;
  socket.on("log.error", (data) => {
    const message = (data as { message?: string } | undefined)?.message;
    if (message) lastError = message;
  });
  await socket.connect();
  return { socket, lastError: () => lastError };
}

export async function logs(options: LogsOptions): Promise<void> {
  const serviceId = await requireService(
    options.service,
    process.cwd(),
    "Reading logs",
    "logs <service> [--follow]",
    { project: options.project },
  );
  const token = gatewayToken();

  const out = options.out ?? ((text: string) => void process.stdout.write(text));
  const print = (line: RuntimeLogLine): void => {
    out(options.json ? `${JSON.stringify(line)}\n` : formatLine(line, options.timestamps));
  };

  if (options.follow) {
    await follow(serviceId, token, print, options.signal);
    return;
  }

  const lines = await recent(serviceId, token, Math.min(options.limit ?? DEFAULT_LINES, MAX_PAGE));
  for (const line of lines) print(line);
  if (lines.length === 0 && !options.json) {
    write(`No recent log lines from service ${serviceId}.\n`);
  }
}

/**
 * The most recent `limit` lines, oldest first. Asks for a page before "now"
 * when the service's node can serve one; otherwise joins the live tail, takes
 * the backlog it replays, and leaves once it goes quiet.
 */
async function recent(serviceId: string, token: string, limit: number): Promise<RuntimeLogLine[]> {
  const { socket, lastError } = await open(token);
  try {
    let older: OlderLogsAck;
    try {
      older = await withAuthRetry(socket, () =>
        socket.request<OlderLogsAck>("olderServiceLogs", {
          serviceId,
          before: new Date(Date.now() + 1_000).toISOString(),
          limit,
        }),
      );
    } catch (error) {
      if (lastError()) throw refused(lastError(), serviceId);
      throw error;
    }
    if (older.ok) return older.lines ?? [];
    // A refusal that is about who is asking or what the service is ends here;
    // anything else (an older node agent that cannot page) falls back to the tail.
    if (/unauthori[sz]ed|session ended|forbidden|not found|permission|only available/i.test(older.error ?? "")) {
      throw refused(older.error, serviceId);
    }

    const collected: RuntimeLogLine[] = [];
    let quiet: NodeJS.Timeout | undefined;
    const done = new Promise<void>((resolve) => {
      const settle = (): void => {
        clearTimeout(quiet);
        quiet = setTimeout(resolve, QUIET_MS);
      };
      socket.on("service.log", (data) => {
        const line = data as RuntimeLogLine;
        if (line?.serviceId !== serviceId) return;
        collected.push(line);
        settle();
      });
      settle();
      setTimeout(resolve, COLLECT_MAX_MS);
      void socket.closed.then(() => resolve());
    });
    const joined = await withAuthRetry(socket, () => socket.request<JoinAck>("joinService", { serviceId }));
    if (!joined.ok) throw refused(joined.error ?? lastError(), serviceId);
    await done;
    clearTimeout(quiet);
    socket.emit("leaveService", { serviceId });
    return collected.slice(-limit);
  } finally {
    socket.close();
  }
}

/**
 * Prints the recent backlog, then every new line until Ctrl-C. A dropped link
 * is reopened with backoff; the backlog the gateway replays on the rejoin is
 * filtered against what was already printed.
 */
async function follow(
  serviceId: string,
  token: string,
  print: (line: RuntimeLogLine) => void,
  signal?: AbortSignal,
): Promise<void> {
  const seen = new SeenLines();
  let stopping = false;
  let current: LogsSocket | null = null;
  let wake: (() => void) | undefined;

  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    if (current) {
      current.emit("leaveService", { serviceId });
      current.close();
    }
    wake?.();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  signal?.addEventListener("abort", stop, { once: true });

  /** The reconnect backoff, cut short by Ctrl-C. */
  const backoff = (attempt: number): Promise<void> =>
    new Promise<void>((resolve) => {
      wake = resolve;
      void pause(attempt).then(resolve);
    }).finally(() => (wake = undefined));

  let attempts = 0;
  let firstConnect = true;
  try {
    while (!stopping) {
      let socket: LogsSocket;
      let lastError: () => string | undefined;
      try {
        ({ socket, lastError } = await open(token));
      } catch (error) {
        if (firstConnect) throw error;
        await backoff(++attempts);
        continue;
      }
      if (stopping) {
        socket.close();
        break;
      }
      current = socket;

      let state: string | undefined;
      socket.on("service.log", (data) => {
        const line = data as RuntimeLogLine;
        if (line?.serviceId !== serviceId) return;
        if (seen.add(line)) print(line);
      });
      socket.on("service.logStatus", (data) => {
        const status = data as RuntimeLogStatus;
        if (status?.serviceId !== serviceId || status.state === state) return;
        if (status.state === "reconnecting") {
          write(`… the log stream is reconnecting${status.message ? ` (${status.message})` : ""}\n`);
        } else if (state === "reconnecting" && status.state === "live") {
          write("… live again\n");
        }
        state = status.state;
      });

      let joined: JoinAck;
      try {
        joined = await withAuthRetry(socket, () => socket.request<JoinAck>("joinService", { serviceId }));
      } catch (error) {
        socket.close();
        if (stopping) break;
        if (lastError() && /unauthori[sz]ed|session ended/i.test(lastError() ?? "")) {
          throw refused(lastError(), serviceId);
        }
        if (firstConnect) throw error;
        await backoff(++attempts);
        continue;
      }
      if (!joined.ok) {
        socket.close();
        throw refused(joined.error ?? lastError(), serviceId);
      }
      if (firstConnect) {
        write(`Following service ${serviceId}. Ctrl-C to stop.\n`);
      } else {
        write("… reconnected\n");
      }
      firstConnect = false;
      attempts = 0;

      const reason = await socket.closed;
      current = null;
      if (stopping) break;
      if (/unauthori[sz]ed|session ended/i.test(lastError() ?? "")) throw refused(lastError(), serviceId);
      write(`… lost the log stream (${reason}); reconnecting\n`);
      await backoff(++attempts);
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    signal?.removeEventListener("abort", stop);
    current?.close();
  }
}

/** 1s, 2s, 4s … capped, before reconnect attempt `n`. */
function pause(attempt: number): Promise<void> {
  const ms = Math.min(RETRY_MAX_MS, 1_000 * 2 ** Math.max(0, attempt - 1));
  return new Promise((resolve) => setTimeout(resolve, ms));
}
