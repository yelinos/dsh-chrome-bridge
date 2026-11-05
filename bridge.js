/**
 * DSH Chrome Bridge — protocol server.
 *
 * A framework-free WebSocket server the DSH Chrome Bridge extension connects
 * to. Speaks one JSON message protocol:
 *
 *   extension → host   {type:"hello", name, version, userAgent, token?}
 *   host → extension   {type:"welcome", ok, protocol, error?}
 *   host → extension   {type:"ping"}                       (keepalive, 20s)
 *   extension → host   {type:"pong"}
 *   host → extension   {id, cmd, ...params}                (command)
 *   extension → host   {id, ok:true, result} | {id, ok:false, error}
 *
 * Multiple extension connections are kept by `browserId` (one per browser or
 * profile). Commands go to the active browser; `setActiveBrowser()` switches
 * it. A reconnect for the same browser replaces that browser's old socket.
 * Pending commands fail only for the browser whose connection drops.
 *
 * @module dsh-chrome-bridge/bridge
 */
import { WebSocketServer, WebSocket } from "ws";

/** Protocol version; the extension and the server must agree on it. */
export const PROTOCOL_VERSION = 1;

/** Error thrown when a command is issued without a connected extension. */
export const NOT_CONNECTED_MESSAGE =
  "DSH Chrome Bridge: the Chrome extension is not connected. " +
  "Load the unpacked extension from the dsh-chrome-bridge bundle's extension/ directory " +
  "(chrome://extensions → Developer mode → Load unpacked), open its popup, and confirm it shows Connected.";

/**
 * Create a bridge server. Nothing listens until {@link listen} resolves.
 *
 * @param {object} [options]
 * @param {string} [options.host="127.0.0.1"] - Interface to bind.
 * @param {number} [options.port=8765] - Port to bind.
 * @param {string} [options.authToken=""] - When non-empty, the extension's
 *   hello must carry the same token.
 * @param {number} [options.commandTimeoutMs=20000] - Per-command deadline.
 * @param {number} [options.keepaliveIntervalMs=20000] - App-level ping period;
 *   message traffic every ≤30s also keeps the MV3 service worker alive.
 * @param {(message: string) => void} [options.log] - Diagnostic sink.
 * @param {() => void} [options.onStateChange] - Called when the extension
 *   connects or disconnects, so observers can refresh.
 * @returns The bridge server handle.
 */
export function createBridgeServer(options = {}) {
  const {
    host = "127.0.0.1",
    port = 8765,
    authToken = "",
    commandTimeoutMs = 20000,
    keepaliveIntervalMs = 20000,
    log = () => {},
    onStateChange = () => {},
  } = options;

  /** @type {import("ws").WebSocketServer | null} */
  let wss = null;
  /** @type {Map<string, {socket: import("ws").WebSocket, info: {id: string, name: string, version: string, userAgent: string, browserName: string}}>} */
  const connections = new Map();
  /** Currently selected browser id. */
  let activeBrowserId = null;
  /** @type {{id: string, name: string, version: string, userAgent: string, browserName: string} | null} */
  let extension = null;
  /** @type {Error | null} */
  let startError = null;
  let listening = false;
  let disposed = false;
  let nextCommandId = 1;
  /** @type {Map<number, {resolve: (v: any) => void, reject: (e: Error) => void, timer: any, browserId: string}>} */
  const pending = new Map();
  let keepaliveTimer = null;

  function sendJson(sock, value) {
    if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(value));
  }

  function activeConnection() {
    return activeBrowserId === null ? null : connections.get(activeBrowserId) ?? null;
  }

  function refreshActiveExtension() {
    extension = activeConnection()?.info ?? null;
  }

  function failAllPending(reason, browserId = null) {
    for (const [id, entry] of pending) {
      if (browserId !== null && entry.browserId !== browserId) continue;
      clearTimeout(entry.timer);
      entry.reject(new Error(`DSH Chrome Bridge: ${reason}`));
      pending.delete(id);
    }
  }

  function handleSocketMessage(sock, raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message === null || typeof message !== "object") return;
    if (message.type === "pong") return;
    if (message.type === "hello") {
      if (authToken && message.token !== authToken) {
        log("extension hello rejected: auth token mismatch");
        sendJson(sock, { type: "welcome", ok: false, error: "auth token mismatch" });
        sock.close(4003, "unauthorized");
        return;
      }
      const browserId = String(message.browserId ?? "default");
      const previous = connections.get(browserId);
      if (previous !== undefined && previous.socket !== sock && previous.socket.readyState === WebSocket.OPEN) {
        previous.socket.close(4000, "replaced by a newer connection");
      }
      const info = {
        id: browserId,
        name: String(message.name ?? "unknown"),
        version: String(message.version ?? ""),
        userAgent: String(message.userAgent ?? ""),
        browserName: String(message.browserName ?? "Chromium"),
      };
      connections.set(browserId, { socket: sock, info });
      if (activeBrowserId === null || activeBrowserId === browserId || !connections.has(activeBrowserId)) {
        activeBrowserId = browserId;
        refreshActiveExtension();
      }
      failAllPending("extension reconnected; pending commands were dropped", browserId);
      sendJson(sock, { type: "welcome", ok: true, protocol: PROTOCOL_VERSION });
      log(`extension connected: ${info.browserName} ${info.name} ${info.version} (${browserId})`);
      onStateChange();
      return;
    }
    if (Number.isInteger(message.id)) {
      const entry = pending.get(message.id);
      if (entry !== undefined) {
        if (message.ok) entry.resolve(message.result);
        else entry.reject(new Error(String(message.error ?? "extension command failed")));
      }
    }
  }

  /** Start listening; resolves once bound, rejects on bind failure. Safe to
   * re-call after a failed attempt (the dead server is dropped first). */
  function listen() {
    return new Promise((resolve, reject) => {
      if (disposed) {
        reject(new Error("DSH Chrome Bridge: server already disposed"));
        return;
      }
      if (listening) {
        resolve();
        return;
      }
      if (wss !== null) {
        try {
          wss.close();
        } catch {
          /* already closed */
        }
        wss = null;
      }
      wss = new WebSocketServer({ host, port }, () => {
        listening = true;
        keepaliveTimer = setInterval(() => {
          for (const connection of connections.values()) {
            if (connection.socket.readyState === WebSocket.OPEN) sendJson(connection.socket, { type: "ping" });
          }
        }, keepaliveIntervalMs);
        log(`listening on ws://${host}:${port}`);
        resolve();
      });
      wss.on("error", (error) => {
        startError = error;
        listening = false;
        log(`server error: ${error.message}`);
        reject(error);
      });
      wss.on("connection", (sock) => {
        sock.on("message", (data) => handleSocketMessage(sock, data));
        sock.on("close", () => {
          for (const [browserId, connection] of connections) {
            if (connection.socket !== sock) continue;
            connections.delete(browserId);
            failAllPending("extension disconnected", browserId);
            if (activeBrowserId === browserId) {
              activeBrowserId = connections.keys().next().value ?? null;
              refreshActiveExtension();
            }
            log(`extension disconnected: ${browserId}`);
            onStateChange();
            break;
          }
        });
        sock.on("error", () => {});
      });
    });
  }

  /**
   * Send one command to the extension and await its response. Rejects (never
   * throws synchronously) when no extension is connected.
   *
   * @param {string} cmd - Command name, e.g. "tabs.open".
   * @param {object} [params] - Command parameters.
   * @param {AbortSignal} [signal] - Aborts the wait (the extension may still
   *   complete the work; only the local wait is abandoned).
   * @param {string} [browserId] - Route to a specific connected browser.
   * @returns {Promise<any>} The extension's result value.
   */
  function command(cmd, params = {}, signal, browserId) {
    const connection = browserId == null ? activeConnection() : connections.get(browserId) ?? null;
    if (connection === null || connection.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(NOT_CONNECTED_MESSAGE));
    }
    const id = nextCommandId++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        pending.delete(id);
        clearTimeout(timer);
        if (signal !== undefined && abortListener !== undefined) {
          signal.removeEventListener("abort", abortListener);
        }
        fn(value);
      };
      const timer = setTimeout(
        () => settle(reject, new Error(`DSH Chrome Bridge: command ${cmd} timed out after ${commandTimeoutMs}ms`)),
        commandTimeoutMs
      );
      const abortListener = () =>
        settle(reject, signal.reason ?? new Error(`DSH Chrome Bridge: command ${cmd} aborted`));
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer);
          reject(signal.reason ?? new Error(`DSH Chrome Bridge: command ${cmd} aborted`));
          return;
        }
        signal.addEventListener("abort", abortListener, { once: true });
      }
      pending.set(id, {
        resolve: (v) => settle(resolve, v),
        reject: (e) => settle(reject, e),
        timer,
        browserId: connection.info.id,
      });
      sendJson(connection.socket, { id, cmd, ...params });
    });
  }

  /** Snapshot of the bridge state, for chrome_status and diagnostics. */
  function status() {
    return {
      listening,
      host,
      port,
      connected: connections.size > 0,
      extension,
      activeBrowserId,
      browsers: [...connections.values()].map((connection) => ({ ...connection.info, active: connection.info.id === activeBrowserId })),
      startError: startError === null ? null : String(startError.message ?? startError),
      pendingCommands: pending.size,
    };
  }

  /** Switch the browser used by subsequent commands. */
  function setActiveBrowser(browserId) {
    if (!connections.has(browserId)) return false;
    activeBrowserId = browserId;
    refreshActiveExtension();
    onStateChange();
    return true;
  }

  /** Stop the server, drop extensions, and fail every pending command. */
  function dispose() {
    disposed = true;
    listening = false;
    if (keepaliveTimer !== null) clearInterval(keepaliveTimer);
    keepaliveTimer = null;
    failAllPending("bridge disposed");
    connections.clear();
    activeBrowserId = null;
    extension = null;
    if (wss !== null) {
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch {
          /* already closed */
        }
      }
      wss.close();
    }
    wss = null;
  }

  return {
    listen,
    command,
    status,
    setActiveBrowser,
    dispose,
    /** Await nothing; the handle exists so tests and the service share one shape. */
    get protocolVersion() {
      return PROTOCOL_VERSION;
    },
  };
}
