/** Service lifecycle test: the real ChromeBridgeService over a real cordis Context. */
import { Context } from "@deepseek-ai/cordis";
import ChromeBridgeService from "./../service.js";
import { assert, assertEqual, connectFakeExtension } from "./helpers.mjs";

const results = [];
function report(ok, name, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

const PORT = 18820;
const ctx = new Context();

try {
  const fiber = ctx.plugin(ChromeBridgeService, {
    host: "127.0.0.1",
    port: PORT,
    authToken: "",
    commandTimeoutMs: 1500,
  });
  await fiber;
  const service = ctx.get("chromeBridge");
  report(service?.constructor?.name === "ChromeBridgeService", "service provided after fiber settles");

  const status = service.status();
  report(status.listening === true, "server bound by [Service.init]", JSON.stringify(status));
  report(status.connected === false, "no extension yet");
  report(
    typeof status.extensionDir === "string" && status.extensionDir.endsWith("/extension/"),
    "status exposes the bundled extension directory",
    status.extensionDir
  );

  const ext = await connectFakeExtension({
    port: PORT,
    handlers: { "ext.ping": () => ({ version: "test" }) },
  });
  report(service.status().connected === true, "extension connects to the service's server");
  const ping = await service.command("ext.ping");
  report(ping?.version === "test", "command round-trip through the service");

  await fiber.dispose();
  const after = service.status();
  report(after.listening === false, "fiber disposal releases the port");
  ext.close();
} catch (error) {
  report(false, "service lifecycle crashed", error.message);
}

console.log(results.join("\n"));
console.log(process.exitCode ? "\nSERVICE TESTS FAILED" : "\nALL SERVICE TESTS PASSED");
