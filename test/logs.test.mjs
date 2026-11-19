// `logs [-f]`: the socket.io codec, and the command against a stand-in for the
// control plane's `/logs` gateway — a bare WebSocket server speaking the slice
// of Engine.IO / socket.io the CLI uses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";

/**
 * Runs `logs` with its lines collected through `out`, and stderr captured.
 * stdout is left alone: under `node --test` it carries the runner's own
 * reports, and a follow that runs for a second would swallow them.
 */
async function runLogs(options) {
  const { logs } = await import("../build/commands/logs.js");
  const out = [];
  const err = [];
  const realErr = process.stderr.write;
  process.stderr.write = (chunk) => (err.push(String(chunk)), true);
  let error;
  try {
    await logs({ service: SERVICE, limit: undefined, timestamps: false, json: false, out: (text) => out.push(text), ...options });
  } catch (caught) {
    error = caught;
  } finally {
    process.stderr.write = realErr;
  }
  return { out: out.join(""), err: err.join(""), error };
}

const SERVICE = "11111111-1111-4111-8111-111111111111";
const hasWebSocket = typeof globalThis.WebSocket === "function";

test("socket.io packets encode and decode the way the gateway writes them", async () => {
  const { decodePacket, encodePacket, logsSocketUrl } = await import("../build/api/logs-socket.js");
  assert.equal(encodePacket({ type: 0, nsp: "/logs", data: { token: "t" } }), '40/logs,{"token":"t"}');
  assert.equal(
    encodePacket({ type: 2, nsp: "/logs", id: 7, data: ["joinService", { serviceId: "s" }] }),
    '42/logs,7["joinService",{"serviceId":"s"}]',
  );
  assert.deepEqual(decodePacket('43/logs,7[{"ok":true}]'), { type: 3, nsp: "/logs", id: 7, data: [{ ok: true }] });
  assert.deepEqual(decodePacket('42/logs,["service.log",{"line":"hi"}]'), {
    type: 2,
    nsp: "/logs",
    data: ["service.log", { line: "hi" }],
  });
  assert.deepEqual(decodePacket("41/logs,"), { type: 1, nsp: "/logs" });
  assert.equal(decodePacket("2"), null);
  assert.equal(logsSocketUrl("https://api.naijacloud.com"), "wss://api.naijacloud.com/socket.io/?EIO=4&transport=websocket");
  assert.equal(logsSocketUrl("http://127.0.0.1:4003"), "ws://127.0.0.1:4003/socket.io/?EIO=4&transport=websocket");
});

test("a reconnect's replayed backlog is not printed twice", async () => {
  const { SeenLines } = await import("../build/commands/logs.js");
  const seen = new SeenLines();
  const line = { serviceId: SERVICE, stream: "STDOUT", line: "ready", at: "2026-11-19T10:00:00.000Z", ts: "2026-11-19T10:00:00.000000001Z", timestamped: true };
  assert.equal(seen.add(line), true);
  assert.equal(seen.add({ ...line }), false);
  assert.equal(seen.add({ ...line, ts: "2026-11-19T10:00:01.000000001Z" }), true);
});

/* -------------------------------------------------------------------------- */
/* A stand-in gateway                                                         */
/* -------------------------------------------------------------------------- */

function frame(text) {
  const payload = Buffer.from(text);
  const header =
    payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([header, payload]);
}

/** Reads the client's (masked) text frames out of `buffer`; returns [texts, rest]. */
function unframe(buffer) {
  const texts = [];
  let offset = 0;
  while (buffer.length - offset >= 6) {
    const opcode = buffer[offset] & 0x0f;
    let length = buffer[offset + 1] & 0x7f;
    let head = 2;
    if (length === 126) {
      length = buffer.readUInt16BE(offset + 2);
      head = 4;
    }
    if (buffer.length - offset < head + 4 + length) break;
    const mask = buffer.subarray(offset + head, offset + head + 4);
    const data = Buffer.from(buffer.subarray(offset + head + 4, offset + head + 4 + length));
    for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    if (opcode === 1) texts.push(data.toString());
    if (opcode === 8) texts.push(null);
    offset += head + 4 + length;
  }
  return [texts, buffer.subarray(offset)];
}

/**
 * `onEvent(socket, name, data, ack)` answers the client's events; `socket.emit`
 * sends one to the client. Every connection's frames are kept in `received`.
 */
async function gateway({ token = "session-jwt", onEvent }) {
  const received = [];
  const sockets = [];
  const server = createServer();
  server.on("upgrade", (request, conn) => {
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    conn.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const socket = {
      path: request.url,
      send: (text) => conn.write(frame(text)),
      emit: (name, data) => socket.send(`42/logs,${JSON.stringify([name, data])}`),
      drop: () => conn.destroy(),
    };
    sockets.push(socket);
    socket.send('0{"sid":"x","pingInterval":25000,"pingTimeout":20000}');
    let pending = Buffer.alloc(0);
    conn.on("data", (chunk) => {
      let texts;
      [texts, pending] = unframe(Buffer.concat([pending, chunk]));
      for (const text of texts) {
        if (text === null) return conn.end();
        received.push(text);
        if (text.startsWith("40/logs,")) {
          const auth = JSON.parse(text.slice("40/logs,".length));
          socket.send('40/logs,{"sid":"y"}');
          if (auth.token !== token) {
            socket.emit("log.error", { message: "unauthorized" });
            socket.send("41/logs,");
          }
          continue;
        }
        const match = /^42\/logs,(\d*)(.*)$/s.exec(text);
        if (!match) continue;
        const [name, data] = JSON.parse(match[2]);
        const ack = (answer) => socket.send(`43/logs,${match[1]}${JSON.stringify([answer])}`);
        onEvent(socket, name, data, ack);
      }
    });
    conn.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    sockets,
    close: () => {
      for (const socket of sockets) socket.drop();
      server.close();
    },
  };
}

const line = (n) => ({
  serviceId: SERVICE,
  stream: "STDOUT",
  line: `line ${n}`,
  at: `2026-11-19T10:00:0${n}.000Z`,
  ts: `2026-11-19T10:00:0${n}.000000000Z`,
  timestamped: true,
});

async function withGateway(options, fn) {
  const gw = await gateway(options);
  const previous = { base: process.env.HOSTING_API_BASE_URL, token: process.env.HOSTING_API_TOKEN };
  process.env.HOSTING_API_BASE_URL = gw.url;
  process.env.HOSTING_API_TOKEN = options.clientToken ?? "session-jwt";
  try {
    return await fn(gw);
  } finally {
    gw.close();
    for (const [key, name] of [["base", "HOSTING_API_BASE_URL"], ["token", "HOSTING_API_TOKEN"]]) {
      if (previous[key] === undefined) delete process.env[name];
      else process.env[name] = previous[key];
    }
  }
}

test("logs prints the most recent lines and exits", { skip: !hasWebSocket }, async () => {
  await withGateway(
    {
      onEvent: (_socket, name, data, ack) => {
        if (name === "olderServiceLogs") {
          assert.equal(data.serviceId, SERVICE);
          assert.equal(data.limit, 2);
          ack({ ok: true, lines: [line(1), line(2)], hasMore: true });
        }
      },
    },
    async (gw) => {
      const result = await runLogs({ follow: false, limit: 2 });
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.out, "line 1\nline 2\n");
      assert.equal(gw.sockets[0].path, "/socket.io/?EIO=4&transport=websocket");
      assert.equal(gw.received[0], '40/logs,{"token":"session-jwt"}');
    },
  );
});

test("logs -f follows, survives a dropped link, and prints nothing twice", { skip: !hasWebSocket }, async () => {
  let joins = 0;
  const stop = new AbortController();
  await withGateway(
    {
      onEvent: (socket, name, _data, ack) => {
        if (name !== "joinService") return;
        joins += 1;
        ack({ ok: true, room: `service:${SERVICE}` });
        if (joins === 1) {
          // The backlog, one live line, then the link drops.
          socket.emit("service.log", line(1));
          socket.emit("service.log", line(2));
          setTimeout(() => {
            socket.emit("service.log", line(3));
            setTimeout(() => socket.drop(), 20);
          }, 20);
        } else {
          // The rejoin replays the backlog, which now ends at line 3.
          socket.emit("service.log", line(2));
          socket.emit("service.log", line(3));
          socket.emit("service.log", line(4));
          setTimeout(() => stop.abort(), 50);
        }
      },
    },
    async () => {
      const result = await runLogs({ follow: true, timestamps: true, signal: stop.signal });
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(
        result.out,
        [1, 2, 3, 4].map((n) => `2026-11-19T10:00:0${n}.000Z line ${n}\n`).join(""),
      );
      assert.equal(joins, 2);
      assert.match(result.err, /reconnected/);
    },
  );
});

test("logs with a rejected session says to log in again", { skip: !hasWebSocket }, async () => {
  await withGateway({ clientToken: "expired", onEvent: (_s, _n, _d, ack) => ack({ ok: false, error: "unauthorized" }) }, async () => {
    const result = await runLogs({ follow: true });
    assert.ok(result.error, "expected an error");
    assert.match(result.error.message, /login/);
  });
});

test("logs refuses a workspace API key before connecting", async () => {
  const previous = process.env.HOSTING_API_TOKEN;
  process.env.HOSTING_API_TOKEN = "nc_live_abc";
  try {
    const result = await runLogs({ follow: false });
    assert.ok(result.error, "expected an error");
    assert.match(result.error.message, /API key/);
  } finally {
    if (previous === undefined) delete process.env.HOSTING_API_TOKEN;
    else process.env.HOSTING_API_TOKEN = previous;
  }
});
