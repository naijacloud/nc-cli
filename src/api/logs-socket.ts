/**
 * A client for the control plane's runtime-log gateway.
 *
 * A service's runtime logs are not on the REST API: the control plane tails
 * the container on its node and relays the lines over socket.io, on the
 * `/logs` namespace of the API host — the stream the dashboard's Logs tab
 * reads. This is the small part of socket.io that stream needs, spoken over the
 * runtime's own `WebSocket` (Node 22+, Bun), so the CLI keeps its two
 * dependencies:
 *
 *   - Engine.IO v4 over the websocket transport, one packet per frame:
 *     `0{…}` open, `2` ping (answered `3`), `4…` a socket.io packet, `1` close.
 *   - socket.io packets for the `/logs` namespace: `0/logs,{auth}` connect,
 *     `2/logs,<id>[event, data]` an event (with an ack id when one is wanted),
 *     `3/logs,<id>[answer]` its ack, `4/logs,{…}` a refused connect,
 *     `1/logs,` a disconnect.
 *
 * Gateway events used (see the control plane's logs.gateway.ts):
 *   joinService { serviceId } → ack { ok, error? }, then `service.log` lines
 *   (the recent backlog first) and `service.logStatus` changes;
 *   olderServiceLogs { serviceId, before, limit } → ack { ok, lines, hasMore };
 *   `log.error` { message } when the session or a room is refused.
 */

import process from "node:process";

import { NaijaCloudError, apiBaseUrl } from "./transport.js";

const NAMESPACE = "/logs";

/** How long one request (connect, join, a page of lines) may take. */
const ACK_TIMEOUT_MS = 20_000;

/* -------------------------------------------------------------------------- */
/* Packet codec                                                               */
/* -------------------------------------------------------------------------- */

/** socket.io packet types (the digit after Engine.IO's `4`). */
export const PacketType = {
  CONNECT: 0,
  DISCONNECT: 1,
  EVENT: 2,
  ACK: 3,
  CONNECT_ERROR: 4,
} as const;

export interface SocketPacket {
  type: number;
  nsp: string;
  id?: number;
  data?: unknown;
}

/** One socket.io packet as the text of an Engine.IO `message` frame. */
export function encodePacket(packet: SocketPacket): string {
  let text = `4${packet.type}`;
  if (packet.nsp !== "/") text += `${packet.nsp},`;
  if (packet.id !== undefined) text += String(packet.id);
  if (packet.data !== undefined) text += JSON.stringify(packet.data);
  return text;
}

/**
 * Reads the socket.io packet out of an Engine.IO `message` frame (`4…`), or
 * null for any other frame, a binary packet, or text that does not parse.
 */
export function decodePacket(frame: string): SocketPacket | null {
  if (frame[0] !== "4" || frame.length < 2) return null;
  const type = Number(frame[1]);
  if (!Number.isInteger(type) || type > PacketType.CONNECT_ERROR) return null;

  let index = 2;
  let nsp = "/";
  if (frame[index] === "/") {
    const comma = frame.indexOf(",", index);
    if (comma === -1) {
      nsp = frame.slice(index);
      index = frame.length;
    } else {
      nsp = frame.slice(index, comma);
      index = comma + 1;
    }
  }

  let digits = "";
  while (index < frame.length && /\d/.test(frame[index] as string)) {
    digits += frame[index];
    index += 1;
  }

  const packet: SocketPacket = { type, nsp };
  if (digits !== "") packet.id = Number(digits);
  const rest = frame.slice(index);
  if (rest !== "") {
    try {
      packet.data = JSON.parse(rest);
    } catch {
      return null;
    }
  }
  return packet;
}

/**
 * The gateway's websocket URL for an API base URL: same host, `ws`/`wss`, at
 * socket.io's default path. The base URL has already been checked by
 * `requestToken()` (https, or http to this machine only).
 */
export function logsSocketUrl(base: string = apiBaseUrl()): string {
  const url = new URL(base);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/socket.io/`;
  url.search = "?EIO=4&transport=websocket";
  url.hash = "";
  return url.toString();
}

/* -------------------------------------------------------------------------- */
/* Gateway payloads                                                           */
/* -------------------------------------------------------------------------- */

/** One runtime line, as the gateway emits `service.log`. */
export interface RuntimeLogLine {
  serviceId: string;
  stream: "STDOUT" | "STDERR" | string;
  line: string;
  /** When the app printed it, or — when `timestamped` is false — when it was relayed. */
  at: string;
  /** The daemon's nanosecond stamp, when the node agent sends one. */
  ts?: string;
  timestamped: boolean;
}

/** The tail's state, as the gateway emits `service.logStatus`. */
export interface RuntimeLogStatus {
  serviceId: string;
  state: "live" | "reconnecting" | string;
  timestamped: boolean;
  canPage: boolean;
  message?: string;
  at: string;
}

export interface JoinAck {
  ok: boolean;
  room?: string;
  error?: string;
}

export interface OlderLogsAck {
  ok: boolean;
  lines?: RuntimeLogLine[];
  hasMore?: boolean;
  error?: string;
}

/* -------------------------------------------------------------------------- */
/* Connection                                                                 */
/* -------------------------------------------------------------------------- */

/** The runtime's WebSocket constructor, or a clear error when it has none. */
function webSocketClass(): typeof WebSocket {
  const ctor = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (typeof ctor !== "function") {
    throw new NaijaCloudError(
      `Runtime logs need a WebSocket client, which Node.js has from version 22 ` +
        `(this is ${process.version}). Upgrade Node, or install the standalone binary.`,
      { code: "NO_WEBSOCKET" },
    );
  }
  return ctor;
}

type Listener = (data: unknown) => void;

/**
 * One connection to the `/logs` namespace. `connect()` resolves once the
 * namespace has accepted the token; `closed` resolves when the connection ends
 * for any reason, with the reason.
 */
export class LogsSocket {
  private ws: WebSocket | null = null;
  private nextAckId = 0;
  private readonly acks = new Map<number, (data: unknown) => void>();
  private readonly listeners = new Map<string, Listener[]>();
  private heartbeat: NodeJS.Timeout | undefined;
  private heartbeatWindowMs = 45_000;
  private ended = false;
  private resolveClosed!: (reason: string) => void;
  /** Resolves with why the connection ended. */
  readonly closed: Promise<string>;

  constructor(
    private readonly token: string,
    private readonly url: string = logsSocketUrl(),
  ) {
    this.closed = new Promise((resolve) => (this.resolveClosed = resolve));
  }

  on(event: string, listener: Listener): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  /** Opens the socket and joins the namespace with the bearer token. */
  async connect(): Promise<void> {
    const WebSocketImpl = webSocketClass();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          this.end(error.message);
          reject(error);
        } else {
          resolve();
        }
      };
      const timer = setTimeout(
        () => settle(new NaijaCloudError(`The log stream at ${apiBaseUrl()} did not answer in time. Try again.`)),
        ACK_TIMEOUT_MS,
      );

      let ws: WebSocket;
      try {
        ws = new WebSocketImpl(this.url);
      } catch (cause) {
        settle(new NaijaCloudError(`Cannot open the log stream: ${cause instanceof Error ? cause.message : String(cause)}`));
        return;
      }
      this.ws = ws;

      ws.addEventListener("message", (event: MessageEvent) => {
        if (typeof event.data !== "string") return;
        const frame = event.data;
        switch (frame[0]) {
          case "0": {
            // Engine.IO open: learn the heartbeat, then ask for the namespace.
            try {
              const open = JSON.parse(frame.slice(1)) as { pingInterval?: number; pingTimeout?: number };
              if (open.pingInterval && open.pingTimeout) {
                this.heartbeatWindowMs = open.pingInterval + open.pingTimeout;
              }
            } catch {
              // keep the default window
            }
            this.armHeartbeat();
            this.send(encodePacket({ type: PacketType.CONNECT, nsp: NAMESPACE, data: { token: this.token } }));
            return;
          }
          case "2":
            this.armHeartbeat();
            this.sendRaw("3");
            return;
          case "1":
            this.end("the server closed the connection");
            return;
          case "4":
            break;
          default:
            return;
        }

        const packet = decodePacket(frame);
        if (!packet || packet.nsp !== NAMESPACE) return;
        switch (packet.type) {
          case PacketType.CONNECT:
            settle();
            return;
          case PacketType.CONNECT_ERROR: {
            const message = (packet.data as { message?: string } | undefined)?.message;
            settle(new NaijaCloudError(`The log stream refused the connection${message ? `: ${message}` : "."}`));
            return;
          }
          case PacketType.DISCONNECT:
            this.end("the server ended the session");
            return;
          case PacketType.ACK: {
            const resolveAck = packet.id === undefined ? undefined : this.acks.get(packet.id);
            if (resolveAck && packet.id !== undefined) {
              this.acks.delete(packet.id);
              resolveAck(Array.isArray(packet.data) ? packet.data[0] : packet.data);
            }
            return;
          }
          case PacketType.EVENT: {
            if (!Array.isArray(packet.data) || typeof packet.data[0] !== "string") return;
            const [name, payload] = packet.data as [string, unknown];
            for (const listener of this.listeners.get(name) ?? []) listener(payload);
            return;
          }
        }
      });
      ws.addEventListener("error", () => {
        settle(new NaijaCloudError(`Cannot reach the log stream at ${apiBaseUrl()}. Check your connection and try again.`));
        this.end("the connection failed");
      });
      ws.addEventListener("close", () => {
        settle(new NaijaCloudError(`The log stream at ${apiBaseUrl()} closed before it was ready.`));
        this.end("the connection closed");
      });
    });
  }

  /** Emits `event` and waits for the gateway's answer. */
  async request<T>(event: string, data: unknown, timeoutMs: number = ACK_TIMEOUT_MS): Promise<T> {
    if (this.ended || !this.ws) throw new NaijaCloudError("The log stream is closed.");
    const id = this.nextAckId++;
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.acks.delete(id);
        reject(new NaijaCloudError(`The log stream did not answer ${event} in time. Try again.`));
      }, timeoutMs);
      this.acks.set(id, (answer) => {
        clearTimeout(timer);
        resolve(answer as T);
      });
      void this.closed.then((reason) => {
        if (!this.acks.has(id)) return;
        this.acks.delete(id);
        clearTimeout(timer);
        reject(new NaijaCloudError(`The log stream closed (${reason}).`));
      });
      this.send(encodePacket({ type: PacketType.EVENT, nsp: NAMESPACE, id, data: [event, data] }));
    });
  }

  /** Emits `event` without waiting for an answer. */
  emit(event: string, data: unknown): void {
    this.send(encodePacket({ type: PacketType.EVENT, nsp: NAMESPACE, data: [event, data] }));
  }

  /** Leaves the namespace and closes the socket. */
  close(): void {
    if (this.ended) return;
    this.send(encodePacket({ type: PacketType.DISCONNECT, nsp: NAMESPACE }));
    this.end("closed");
  }

  private send(text: string): void {
    this.sendRaw(text);
  }

  private sendRaw(text: string): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1 /* OPEN */) return;
    try {
      ws.send(text);
    } catch {
      // A socket that is going away reports it through `close`.
    }
  }

  /** No ping within pingInterval + pingTimeout means the link is dead. */
  private armHeartbeat(): void {
    clearTimeout(this.heartbeat);
    this.heartbeat = setTimeout(() => this.end("no heartbeat from the server"), this.heartbeatWindowMs);
  }

  private end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.heartbeat);
    try {
      this.ws?.close();
    } catch {
      // already closing
    }
    this.resolveClosed(reason);
  }
}
