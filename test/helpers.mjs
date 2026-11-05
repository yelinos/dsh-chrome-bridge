/**
 * Test helpers: a fake DSH Chrome Bridge extension client that implements the
 * extension side of the protocol over a real WebSocket, plus tiny assertions.
 */
import { WebSocket } from "ws";

/** @returns {Promise<import("ws").WebSocket>} */
export function connectFakeExtension({ port, token = "", handlers = {}, noReply = [], onHello, browserId, browserName } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const state = { asked: 0, askedDomains: [] };
    const fail = (reason) => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(new Error(reason));
    };
    ws.on("error", fail);
    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "hello",
          name: "Fake Extension",
          version: "test",
          userAgent: "fake",
          ...(browserId ? { browserId } : {}),
          ...(browserName ? { browserName } : {}),
          ...(token ? { token } : {}),
        })
      );
    });
    ws.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (message.type === "welcome") {
        if (message.ok !== true) {
          fail(`welcome rejected: ${message.error}`);
          return;
        }
        resolve(ws);
        if (onHello) onHello(message);
        return;
      }
      if (Number.isInteger(message.id) && typeof message.cmd === "string") {
        const { id, cmd, ...params } = message;
        if (noReply.includes(cmd)) return; // simulate a stalled extension side
        const handler = handlers[cmd];
        Promise.resolve()
          .then(() => {
            if (handler === undefined) throw new Error(`fake extension: no handler for ${cmd}`);
            return handler(params, state);
          })
          .then(
            (result) => ws.send(JSON.stringify({ id, ok: true, result })),
            (error) => ws.send(JSON.stringify({ id, ok: false, error: String(error.message ?? error) }))
          );
      }
    });
    ws.state = state;
  });
}

export function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

export function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`assertion failed: ${message}\n  actual:   ${a}\n  expected: ${b}`);
}

export async function assertRejects(promise, substring, message) {
  try {
    await promise;
  } catch (error) {
    if (substring && !String(error.message).includes(substring)) {
      throw new Error(`assertion failed: ${message} — error was "${error.message}", expected substring "${substring}"`);
    }
    return error;
  }
  throw new Error(`assertion failed: ${message} — promise resolved instead of rejecting`);
}
