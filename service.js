/**
 * DSH Chrome Bridge — Host service.
 *
 * Registers `ctx.chromeBridge`: one bridge server per Host process. The
 * Chrome extension connects here; the sibling tools plugin (package root,
 * `dsh-chrome-bridge`) issues commands through this service, and the Client
 * sidebar card reads `status()` through the Typert remote gateway.
 *
 * Lifecycle note: this cordis fork runs class-plugin constructors while the
 * fiber runner is still inactive, so async work and resource registration
 * belong in `[Service.init]()` (which may return its disposer), never in the
 * constructor.
 *
 * @module dsh-chrome-bridge/service
 */
import { Service } from "@deepseek-ai/cordis";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import z from "@deepseek-ai/schemastery";
import { fileURLToPath } from "node:url";
import { createBridgeServer } from "./bridge.js";

/**
 * Mark one public method of a class as a Typert remote without decorator
 * syntax (plain ESM has none): `Remote` only needs a decorator-like context
 * whose addInitializer runs against an instance of the class.
 * @param {Function} Class - Service class whose prototype owns the method.
 * @param {string} method - Public instance method name.
 */
function markRemoteMethod(Class, method) {
  Remote(Function.prototype, {
    name: method,
    private: false,
    static: false,
    addInitializer(run) {
      run.call(Object.create(Class.prototype));
    },
  });
}

/** Directory of the Chrome extension this bundle ships, for the install guide. */
const EXTENSION_DIR = fileURLToPath(new URL("./extension/", import.meta.url));

export class ChromeBridgeService extends TypertRemoteService {
  /** Bridge server configuration, validated by the Loader at activation. */
  static Config = z.object({
    host: z.string().default("127.0.0.1"),
    port: z.number().step(1).min(1).max(65535).default(8765),
    authToken: z.string().default(""),
    commandTimeoutMs: z.number().default(20000),
  });

  /**
   * Construct only: validate, remember config, and create the (inert) server
   * handle. Binding happens in {@link ChromeBridgeService.prototype.[Service.init]}.
   *
   * @param {import("@deepseek-ai/cordis").Context} ctx - Owning context.
   * @param {object} config - Validated {@link ChromeBridgeService.Config}.
   */
  constructor(ctx, config) {
    super(ctx, "chromeBridge");
    this.config = config;
    /** Resolved when the server is bound; see start(). */
    this.started = Promise.resolve();
    /** @type {Error | null} Bind failure, surfaced through status(). */
    this.startError = null;
    let logger;
    try {
      logger = ctx.logger;
    } catch {
      logger = undefined;
    }
    const log = (message) => {
      try {
        logger?.info?.(`[chrome-bridge] ${message}`);
      } catch {
        /* diagnostics only */
      }
    };
    this.log = log;
    this.server = createBridgeServer({
      host: config.host,
      port: config.port,
      authToken: config.authToken,
      commandTimeoutMs: config.commandTimeoutMs,
      log,
      onStateChange: () => {
        try {
          ctx.emit("chrome-bridge/changed");
        } catch {
          /* observers are optional */
        }
      },
    });
  }

  /**
   * Bind the WebSocket server, then hand the fiber its disposer. A live
   * profile patch can remount this row while the previous fiber's server is
   * still releasing the port, so EADDRINUSE is retried briefly.
   */
  async [Service.init]() {
    this.started = ChromeBridgeService.start(this.server, this.log).then(
      (error) => {
        this.startError = error;
      },
      (error) => {
        this.startError = error;
      }
    );
    await this.started;
    return () => {
      this.server.dispose();
    };
  }

  /** Bind with a bounded EADDRINUSE retry; resolves with the error, if any. */
  static async start(server, log) {
    const deadline = Date.now() + 8000;
    for (;;) {
      try {
        await server.listen();
        return null;
      } catch (error) {
        if (String(error?.code ?? "") !== "EADDRINUSE" || Date.now() >= deadline) return error;
        log(`port busy, retrying: ${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
  }

  /**
   * Bridge status snapshot for `chrome_status` and the sidebar card:
   * server state, connected extension, and where the bundled Chrome
   * extension lives on disk.
   */
  status() {
    return { ...this.server.status(), extensionDir: EXTENSION_DIR };
  }

  /** Issue one command to the connected extension (see createBridgeServer). */
  command(cmd, params, signal, browserId) {
    return this.server.command(cmd, params, signal, browserId);
  }

  /** Switch the browser used by subsequent commands. */
  setActiveBrowser(browserId) {
    return this.server.setActiveBrowser(browserId);
  }
}

markRemoteMethod(ChromeBridgeService, "status");

export default ChromeBridgeService;
