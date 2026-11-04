/** Protocol-layer tests: bridge server ↔ fake extension over real WebSocket. */
import { createBridgeServer, NOT_CONNECTED_MESSAGE, PROTOCOL_VERSION } from "./../bridge.js";
import { WebSocket } from "ws";
import { assert, assertEqual, assertRejects, connectFakeExtension } from "./helpers.mjs";

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(`PASS ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await test("listen + status before connection", async () => {
  const server = createBridgeServer({ port: 18771, commandTimeoutMs: 1000 });
  await server.listen();
  const status = server.status();
  assert(status.listening, "listening");
  assert(!status.connected, "not connected yet");
  assertEqual(status.port, 18771, "port recorded");
  server.dispose();
});

await test("hello → connected; command round-trip; command error; disconnect clears state", async () => {
  const server = createBridgeServer({ port: 18772, commandTimeoutMs: 1000 });
  await server.listen();
  const ext = await connectFakeExtension({
    port: 18772,
    handlers: {
      "ext.ping": () => ({ version: "test" }),
      "tabs.list": () => [{ id: 1, title: "Example", url: "https://example.com" }],
      "tabs.close": () => {
        throw new Error("no such tab");
      },
    },
  });
  const status = server.status();
  assert(status.connected, "connected after hello");
  assertEqual(status.extension.name, "Fake Extension", "hello info recorded");
  assertEqual((await server.command("ext.ping")).version, "test", "round-trip result");
  assertEqual((await server.command("tabs.list"))[0].id, 1, "list result");
  await assertRejects(server.command("tabs.close", { tabId: 9 }), "no such tab", "command error propagates");
  ext.close();
  await sleep(150);
  assert(!server.status().connected, "disconnected after close");
  await assertRejects(server.command("ext.ping"), NOT_CONNECTED_MESSAGE, "commands fail when disconnected");
  server.dispose();
});

await test("command timeout", async () => {
  const server = createBridgeServer({ port: 18773, commandTimeoutMs: 120 });
  await server.listen();
  const ext = await connectFakeExtension({ port: 18773, handlers: {}, noReply: ["never.answered"] });
  await assertRejects(server.command("never.answered"), "timed out", "timeout rejects");
  ext.close();
  server.dispose();
});

await test("abort signal abandons the wait", async () => {
  const server = createBridgeServer({ port: 18774, commandTimeoutMs: 5000 });
  await server.listen();
  const ext = await connectFakeExtension({ port: 18774, handlers: {}, noReply: ["slow.cmd"] });
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("user cancelled")), 100);
  await assertRejects(server.command("slow.cmd", {}, controller.signal), "user cancelled", "abort rejects");
  ext.close();
  server.dispose();
});

await test("disconnect fails pending commands", async () => {
  const server = createBridgeServer({ port: 18775, commandTimeoutMs: 5000 });
  await server.listen();
  const ext = await connectFakeExtension({ port: 18775, handlers: {}, noReply: ["slow.cmd"] });
  const pending = server.command("slow.cmd");
  ext.close();
  await assertRejects(pending, "extension disconnected", "pending rejected on disconnect");
  server.dispose();
});

await test("auth token enforced", async () => {
  const server = createBridgeServer({ port: 18776, commandTimeoutMs: 500, authToken: "secret" });
  await server.listen();
  // Wrong token: the welcome is not ok and the socket is closed.
  await new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:18776");
    ws.on("error", reject);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", name: "x", version: "1", token: "wrong" })));
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "welcome") {
        try {
          assert(message.ok === false, "welcome rejected for wrong token");
          resolve();
        } catch (error) {
          reject(error);
        }
      }
    });
    ws.on("close", () => resolve());
  });
  // Correct token connects.
  const ext = await connectFakeExtension({ port: 18776, token: "secret", handlers: {} });
  assert(server.status().connected, "connected with correct token");
  ext.close();
  server.dispose();
});

await test("a newer connection replaces the older one", async () => {
  const server = createBridgeServer({ port: 18777, commandTimeoutMs: 500 });
  await server.listen();
  const first = await connectFakeExtension({ port: 18777, handlers: {} });
  const second = await connectFakeExtension({ port: 18777, handlers: { "ext.ping": () => ({ version: "second" }) } });
  await sleep(150);
  assert(!first.readyState || first.readyState === WebSocket.CLOSED, "first socket closed after replacement");
  assert(server.status().connected, "still connected via second");
  assertEqual((await server.command("ext.ping")).version, "second", "commands go to the newest connection");
  second.close();
  server.dispose();
});

await test("protocol version exported", async () => {
  assertEqual(PROTOCOL_VERSION, 1, "protocol version");
});

console.log(results.join("\n"));
console.log(process.exitCode ? "\nSOME TESTS FAILED" : "\nALL PROTOCOL TESTS PASSED");
