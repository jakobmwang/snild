// A small Chrome driver for snild's browser tests: the Chrome DevTools Protocol over Node's own WebSocket,
// with no packages and no downloads. It launches an installed Chrome (SNILD_CHROME, or the usual names), opens
// pages in separate browser contexts (separate cookies, like separate people), and records everything that
// must fail a test: console errors, uncaught exceptions and Content-Security-Policy violations.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CANDIDATES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"];

function findChrome() {
  if (process.env.SNILD_CHROME) return process.env.SNILD_CHROME;
  for (const name of CANDIDATES) {
    for (const dir of (process.env.PATH || "").split(":")) {
      if (dir && existsSync(join(dir, name))) return join(dir, name);
    }
  }
  throw new Error("No Chrome found: set SNILD_CHROME to a Chrome or Chromium binary.");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Browser {
  static async launch() {
    const profile = mkdtempSync(join(tmpdir(), "snild-chrome-"));
    const args = [
      "--headless=new",
      // These tests check pages, not process isolation, and must also run where Chrome's OS sandbox cannot
      // start.
      "--no-sandbox",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--metrics-recording-only",
      "--password-store=basic",
      "--window-size=1280,900",
      "about:blank",
    ];
    const proc = spawn(findChrome(), args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-4000)));
    const portFile = join(profile, "DevToolsActivePort");
    const deadline = Date.now() + 20_000;
    while (!existsSync(portFile) || !readFileSync(portFile, "utf8").includes("\n")) {
      if (proc.exitCode !== null) throw new Error(`Chrome exited at start:\n${stderr}`);
      if (Date.now() > deadline) throw new Error(`Chrome did not start:\n${stderr}`);
      await sleep(20);
    }
    const [port, path] = readFileSync(portFile, "utf8").split("\n");
    const browser = new Browser(proc, profile, new WebSocket(`ws://127.0.0.1:${port}${path}`));
    await browser.ready;
    return browser;
  }

  constructor(proc, profile, socket) {
    this.proc = proc;
    this.profile = profile;
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.sessions = new Map(); // sessionId -> Page
    this.ready = new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error("could not connect to Chrome"));
    });
    socket.onmessage = (message) => {
      const data = JSON.parse(message.data);
      if (data.id && this.pending.has(data.id)) {
        const { resolve, reject, method } = this.pending.get(data.id);
        this.pending.delete(data.id);
        if (data.error) reject(new Error(`${method}: ${data.error.message}`));
        else resolve(data.result);
      } else if (data.sessionId && this.sessions.has(data.sessionId)) {
        this.sessions.get(data.sessionId).event(data.method, data.params);
      }
    };
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }

  /** A page in a fresh browser context: its own cookies and storage, like another person's browser. */
  async newPage({ width = 1280, height = 900, context = null } = {}) {
    const browserContextId = context ?? (await this.send("Target.createBrowserContext", { disposeOnDetach: true })).browserContextId;
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank", browserContextId });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(this, sessionId, targetId, browserContextId);
    this.sessions.set(sessionId, page);
    await Promise.all([
      page.send("Page.enable"), page.send("Runtime.enable"), page.send("Log.enable"),
      page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 }),
    ]);
    return page;
  }

  async close() {
    const gone = () => this.proc.exitCode !== null || this.proc.signalCode !== null;
    const exited = gone() ? Promise.resolve() : new Promise((resolve) => this.proc.once("exit", resolve));
    try {
      await Promise.race([this.send("Browser.close"), sleep(2000)]);
    } catch {
      // already gone
    }
    this.socket.close();
    await Promise.race([exited, sleep(3000)]);
    if (!gone()) this.proc.kill("SIGKILL");
    await Promise.race([exited, sleep(3000)]);
    // Chrome's helper processes can still be writing to the profile for a moment after it exits.
    rmSync(this.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

export class Page {
  constructor(browser, sessionId, targetId, context) {
    this.browser = browser;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.context = context;
    /** Console errors, uncaught exceptions and CSP violations: a test fails if any appear. */
    this.problems = [];
    this.loadWaiters = [];
    this.requestHandler = null;
  }

  send(method, params = {}) {
    return this.browser.send(method, params, this.sessionId);
  }

  event(method, params) {
    if (method === "Runtime.exceptionThrown") {
      const details = params.exceptionDetails;
      this.problems.push(`uncaught: ${details.exception?.description || details.text}`);
    } else if (method === "Runtime.consoleAPICalled" && (params.type === "error" || params.type === "assert")) {
      this.problems.push(`console.${params.type}: ${params.args.map((a) => a.value ?? a.description).join(" ")}`);
    } else if (method === "Log.entryAdded" && params.entry.level === "error") {
      this.problems.push(`${params.entry.source}: ${params.entry.text}${params.entry.url ? ` (${params.entry.url})` : ""}`);
    } else if (method === "Page.loadEventFired") {
      for (const resolve of this.loadWaiters.splice(0)) resolve();
    } else if (method === "Fetch.requestPaused" && this.requestHandler) {
      this.requestHandler(params).catch((error) => this.problems.push(`request handler: ${error.message}`));
    }
  }

  /** Problems that are expected in this test (a refused request the test makes on purpose, say). */
  allow(pattern) {
    this.problems = this.problems.filter((p) => !pattern.test(p));
  }

  async goto(url) {
    const loaded = new Promise((resolve) => this.loadWaiters.push(resolve));
    const result = await this.send("Page.navigate", { url });
    if (result.errorText) throw new Error(`could not open ${url}: ${result.errorText}`);
    await loaded;
  }

  async reload() {
    const loaded = new Promise((resolve) => this.loadWaiters.push(resolve));
    await this.send("Page.reload");
    await loaded;
  }

  /** Run a function in the page and return its (JSON) result. */
  async eval(fn, ...args) {
    const expression = typeof fn === "function" ? `(${fn})(...${JSON.stringify(args)})` : fn;
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (exceptionDetails) throw new Error(`in page: ${exceptionDetails.exception?.description || exceptionDetails.text}`);
    return result.value;
  }

  /** Wait until the function returns something truthy in the page; return that. */
  async waitFor(fn, { timeout = 10_000, args = [], what = String(fn).slice(0, 120) } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const value = await this.eval(fn, ...args).catch(() => undefined);
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
      await sleep(50);
    }
  }

  async text(selector) {
    return this.eval((s) => document.querySelector(s)?.textContent ?? null, selector);
  }

  /** Click the middle of an element, as a mouse would (it must be visible and not covered). */
  async click(selector) {
    const point = await this.waitFor((s) => {
      const node = document.querySelector(s);
      if (!node) return null;
      node.scrollIntoView({ block: "center", inline: "center" });
      const box = node.getBoundingClientRect();
      if (!box.width || !box.height) return null;
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      const hit = document.elementFromPoint(x, y);
      return hit && (hit === node || node.contains(hit)) ? { x, y } : null;
    }, { args: [selector], what: `a clickable ${selector}` });
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: type === "mouseMoved" ? 0 : 1 });
    }
  }

  async focus(selector) {
    await this.waitFor((s) => {
      const node = document.querySelector(s);
      node?.focus();
      return node !== null && document.activeElement === node;
    }, { args: [selector], what: `focus on ${selector}` });
  }

  /** Type text into whatever has focus. */
  async type(text) {
    await this.send("Input.insertText", { text });
  }

  async press(key, modifiers = 0) {
    const keys = {
      Enter: { code: "Enter", keyCode: 13, text: "\r" },
      Escape: { code: "Escape", keyCode: 27 },
      Tab: { code: "Tab", keyCode: 9 },
      ArrowDown: { code: "ArrowDown", keyCode: 40 },
      ArrowUp: { code: "ArrowUp", keyCode: 38 },
    };
    const info = keys[key];
    if (!info) throw new Error(`unknown key ${key}`);
    const base = { key, code: info.code, windowsVirtualKeyCode: info.keyCode, nativeVirtualKeyCode: info.keyCode, modifiers };
    await this.send("Input.dispatchKeyEvent", { type: info.text ? "keyDown" : "rawKeyDown", ...base, text: info.text });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  async screenshot(path) {
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path, Buffer.from(data, "base64"));
  }

  async setDarkMode(dark) {
    await this.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
  }

  /**
   * Intercept requests matching urlPattern: the handler gets Fetch.requestPaused params and must continue,
   * fulfil or fail each one (see continueRequest, fulfil, failRequest).
   */
  async intercept(urlPattern, handler, requestStage = "Request") {
    this.requestHandler = handler;
    await this.send("Fetch.enable", { patterns: [{ urlPattern, requestStage }] });
  }

  async stopIntercepting() {
    this.requestHandler = null;
    await this.send("Fetch.disable");
  }

  continueRequest(params) {
    return this.send("Fetch.continueRequest", { requestId: params.requestId });
  }

  fulfil(params, { status = 200, headers = {}, body = "" }) {
    return this.send("Fetch.fulfillRequest", {
      requestId: params.requestId,
      responseCode: status,
      responseHeaders: Object.entries(headers).map(([name, value]) => ({ name, value })),
      body: Buffer.from(body).toString("base64"),
    });
  }

  failRequest(params, errorReason = "ConnectionReset") {
    return this.send("Fetch.failRequest", { requestId: params.requestId, errorReason });
  }

  async close() {
    await this.browser.send("Target.closeTarget", { targetId: this.targetId }).catch(() => {});
    this.browser.sessions.delete(this.sessionId);
  }
}
