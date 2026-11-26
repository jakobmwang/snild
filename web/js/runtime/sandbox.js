// @ts-check
/**
 * Where run_js runs: two locked frames (web/frames/), made when first needed and kept warm.
 *
 * - The code frame runs the model's JavaScript in a fresh worker per call. Its policy names no address: the
 *   code can load and send nothing, anywhere. This page hands it d3 and linkedom as text.
 * - The database frame runs DuckDB for the code's sql(); it reads only the files this page hands it.
 *
 * Each frame is an <iframe sandbox="allow-scripts"> (no origin, no cookies, no way to the page but its one
 * MessageChannel port). The page decides everything that matters from outside the frames: one call at a time,
 * a deadline per call that starts before any frame is ready, a heartbeat while a call runs (a frame that stops
 * answering is replaced), and Stop. A frame's messages count only if they belong to the call that is running,
 * and a call may have only a few requests open at once; anything else is dropped or refused. A frame that
 * misbehaves is thrown away, never trusted again.
 */

const DEADLINE_MS = 30_000;
const PING_MS = 500;
const SILENCE_MS = 3_000;   // no answer to a ping for this long: the frame is gone (crashed, or out of memory)
const GRACE_MS = 2_000;     // a frame asked to cancel or clean up gets this long before it is replaced
const MAX_FILE_BYTES = 1_000_000; // fs.readFile hands over a file whole only up to this size; sql() reads any
const MAX_OPEN_ASKS = 8;    // requests (fs, sql) one call may have waiting at once

/** The files every chat can use, served with the page. */
const DEMO_FILES = ["demo/sales.csv", "demo/sales.xlsx"];

/**
 * What a call came to. `value` is the code's return value as text, `svg` a returned SVG chart.
 * @typedef {{status: "ok" | "error", seconds: number, value?: string, svg?: string, svgChars?: number,
 *            console?: string, error?: string}} RunOutcome
 * @typedef {{job: number, queries: Set<number>, asks: Set<number>, used: () => void}} Active
 */

class Frame {
  /**
   * @param {string} src
   * @param {Promise<Record<string, unknown>>} hello sent with the port, once the frame has loaded
   * @param {(data: any) => void} onMessage what is not a reply, a ready or a pong
   */
  constructor(src, hello, onMessage) {
    /** @type {Map<number, {resolve: (data: any) => void, reject: (error: Error) => void}>} */
    this.waiting = new Map();
    this.next = 0;
    /** Why this frame is no longer used, once it is not. @type {string | null} */
    this.dead = null;
    this.pinged = 0;
    /** @type {ReturnType<typeof setInterval> | 0} */
    this.heartbeat = 0;
    /** Who waits for the next pong (see alive). @type {Set<() => void>} */
    this.probes = new Set();
    this.isReady = false;
    this.job = 0; // the call whose files the database frame holds
    /** The files of that call, once they are in hand. @type {Promise<Record<string, ArrayBuffer>> | null} */
    this.files = null;
    /** The running call's ending, and what to do if the frame dies. @type {((data: any) => void) | null} */
    this.onDone = null;
    /** @type {((reason: string) => void) | null} */
    this.onDeath = null;
    const channel = new MessageChannel();
    this.port = channel.port1;
    /** @type {(value?: unknown) => void} */
    let ready = () => {};
    /** @type {(error: Error) => void} */
    let failed = () => {};
    this.ready = new Promise((resolve, reject) => {
      ready = resolve;
      failed = reject;
    });
    this.ready.catch(() => {}); // a frame dropped before anyone waited for it
    this.failed = failed;
    this.port.onmessage = ({ data }) => {
      if (this.dead || !data || typeof data !== "object") return;
      if (data.type === "pong") {
        this.pinged = 0;
        for (const probe of this.probes) probe();
        this.probes.clear();
      } else if (data.type === "ready") {
        this.isReady = true;
        ready();
      } else if (data.type === "failed") {
        this.destroy(String(data.error));
      } else if (data.type === "reply" && this.waiting.has(data.n)) {
        const waiter = this.waiting.get(data.n);
        this.waiting.delete(data.n);
        waiter?.resolve(data);
      } else {
        onMessage(data);
      }
    };
    this.iframe = document.createElement("iframe");
    this.iframe.setAttribute("sandbox", "allow-scripts");
    this.iframe.hidden = true;
    this.iframe.addEventListener("load", () => {
      hello.then((message) => {
        if (!this.dead) this.iframe.contentWindow?.postMessage({ ...message, type: "hello" }, "*", [channel.port2]);
      }, (/** @type {Error} */ error) => this.destroy(error.message));
    }, { once: true });
    this.iframe.src = src;
    document.body.append(this.iframe);
  }

  /** @param {Record<string, unknown>} message */
  post(message) {
    if (!this.dead) this.port.postMessage(message);
  }

  /**
   * Send a message and wait for its reply.
   * @param {Record<string, unknown>} message
   * @returns {Promise<any>}
   */
  request(message) {
    if (this.dead) return Promise.reject(new Error(this.dead));
    const n = ++this.next;
    return new Promise((resolve, reject) => {
      this.waiting.set(n, { resolve, reject });
      this.port.postMessage({ ...message, n });
    });
  }

  /** Ping while a call uses the frame; silence for SILENCE_MS means it is gone. @param {boolean} on */
  watch(on) {
    if (on && (this.heartbeat || this.dead)) return; // already watched: never restart the clock
    clearInterval(this.heartbeat);
    this.heartbeat = 0;
    this.pinged = 0;
    if (!on) return;
    this.heartbeat = setInterval(() => {
      // Measured from the ping still unanswered, so a timer slowed down in a background tab is no false alarm.
      if (this.pinged && performance.now() - this.pinged > SILENCE_MS) this.destroy("stopped responding");
      else if (!this.pinged) {
        this.pinged = performance.now();
        this.post({ type: "ping" });
      }
    }, PING_MS);
  }

  /** Whether the frame answers a ping within `ms`. @param {number} ms @returns {Promise<boolean>} */
  alive(ms) {
    if (this.dead || !this.isReady) return Promise.resolve(false);
    return new Promise((resolve) => {
      const answered = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.probes.delete(answered);
        resolve(false);
      }, ms);
      this.probes.add(answered);
      this.post({ type: "ping" });
    });
  }

  /** Throw the frame away: whatever waits on it fails with `reason`. @param {string} reason */
  destroy(reason) {
    if (this.dead) return;
    this.dead = reason;
    this.watch(false);
    this.failed(new Error(reason));
    for (const waiter of this.waiting.values()) waiter.reject(new Error(reason));
    this.waiting.clear();
    this.port.close();
    this.iframe.remove();
    this.onDeath?.(reason);
  }
}

export class Sandbox {
  /**
   * @param {string} assets the URL of the versioned assets ("/assets/<version>")
   * @param {{deadlineMs?: number}} [options]
   */
  constructor(assets, { deadlineMs = DEADLINE_MS } = {}) {
    this.assets = assets;
    this.deadlineMs = deadlineMs;
    /** @type {Frame | null} */
    this.code = null;
    /** @type {Frame | null} */
    this.database = null;
    this.jobs = 0;
    /** @type {Promise<unknown>} */
    this.queue = Promise.resolve();
    /** The bytes of each file, fetched once. @type {Map<string, Promise<ArrayBuffer>>} */
    this.bytes = new Map();
    /** d3 and linkedom as text, fetched once, for the code frame. @type {Promise<Record<string, string>> | null} */
    this.libraries = null;
    /** The call that is running. @type {Active | null} */
    this.active = null;
  }

  /**
   * Run code, after any call before it has ended. Rejects with an AbortError if `signal` aborts (Stop): the
   * worker is ended at once and nothing is reported.
   * @param {string} code
   * @param {AbortSignal} [signal]
   * @returns {Promise<RunOutcome>}
   */
  run(code, signal) {
    const turn = this.queue.then(() => this.#job(code, signal));
    this.queue = turn.catch(() => {});
    return turn;
  }

  /** Throw both frames away (signing out): nothing of this person's stays in the page. */
  dispose() {
    this.code?.destroy("closed");
    this.database?.destroy("closed");
    this.bytes.clear();
  }

  #libraries() {
    const text = (/** @type {string} */ path) => fetch(`${this.assets}/vendor/${path}`).then((response) => {
      if (!response.ok) throw new Error(`could not load ${path}`);
      return response.text();
    });
    this.libraries ??= Promise.all([text("d3/d3.min.js"), text("linkedom/worker.js")])
      .then(([d3, linkedom]) => ({ d3, linkedom }));
    this.libraries.catch(() => {
      this.libraries = null; // try again with the next frame
    });
    return this.libraries;
  }

  /**
   * @param {string} code
   * @param {AbortSignal | undefined} signal
   * @returns {Promise<RunOutcome>}
   */
  #job(code, signal) {
    signal?.throwIfAborted();
    const job = ++this.jobs;
    const started = performance.now();
    if (!this.code || this.code.dead) {
      this.code = new Frame(`${this.assets}/frames/code.html`, this.#libraries(), (data) => this.#heard(data));
    }
    const frame = this.code;
    let usedDatabase = false;
    /** @type {Active} */
    const active = { job, queries: new Set(), asks: new Set(), used: () => { usedDatabase = true; } };
    this.active = active;

    return new Promise((resolve, reject) => {
      let over = false;
      /** @type {ReturnType<typeof setTimeout> | 0} */
      let grace = 0;
      const timer = setTimeout(() => cancel(`The code was stopped after ${Math.round(this.deadlineMs / 1000)} s, `
        + "its time limit. Make it do less, or work on less data at once."), this.deadlineMs);

      /** @param {(() => void)} settle */
      const close = async (settle) => {
        if (over) return;
        over = true;
        clearTimeout(timer);
        clearTimeout(grace);
        signal?.removeEventListener("abort", stop);
        frame.watch(false);
        frame.onDone = null;
        frame.onDeath = null;
        this.active = null;
        await this.#tidy(job, usedDatabase, active.queries.size > 0);
        settle();
      };
      const seconds = () => Math.round((performance.now() - started) / 10) / 100;
      /** @param {Omit<RunOutcome, "seconds">} outcome */
      const finish = (outcome) => void close(() => resolve({ ...outcome, seconds: seconds() }));
      /** The job itself drops its frame: this is not a crash, so it says what happened. @param {string} why */
      const drop = (why) => {
        frame.onDeath = null;
        frame.destroy(why);
      };

      /** Deadline: ask the frame to end the worker; whatever it printed until then still counts. @param {string} why */
      const cancel = (why) => {
        if (over) return;
        if (!frame.isReady) {
          drop("did not start");
          finish({ status: "error", error: "The code runner did not start. Try again." });
          return;
        }
        frame.onDone = (data) => finish({ status: "error", error: why, console: String(data.console || "") });
        frame.post({ type: "cancel", job });
        grace = setTimeout(() => {
          drop("did not stop in time");
          finish({ status: "error", error: why });
        }, GRACE_MS);
      };
      // Stop: the worker ends now, nothing is reported. A frame that was still starting is not waited for.
      const stop = () => {
        if (!frame.isReady) drop("stopped before it started");
        else frame.post({ type: "cancel", job });
        void close(() => reject(signal?.reason ?? new DOMException("Stopped", "AbortError")));
      };
      signal?.addEventListener("abort", stop, { once: true });

      frame.onDeath = async () => {
        // The database may have shared the frame's process (Chrome puts frames of one site together), and so its
        // end: if it does not answer, it goes too, before the next call could send it a query.
        const database = this.database;
        if (database && !database.dead && !(await database.alive(1000))) database.destroy("stopped responding");
        finish({ status: "error", error: "The code stopped responding (it may have used too much memory), so it "
          + "was ended. Try again with less data or a simpler approach." });
      };
      frame.onDone = (data) => {
        /** @type {Omit<RunOutcome, "seconds">} */
        const outcome = { status: typeof data.error === "string" ? "error" : "ok" };
        if (typeof data.value === "string") outcome.value = data.value; // "" too: the code did return it
        for (const key of /** @type {const} */ (["svg", "error", "console"])) {
          if (typeof data[key] === "string" && data[key]) outcome[key] = data[key];
        }
        if (typeof data.svgChars === "number") outcome.svgChars = data.svgChars;
        finish(outcome);
      };
      frame.ready.then(() => {
        if (over) return;
        frame.watch(true);
        frame.post({ type: "run", job, code });
      }, () => {}); // a frame that failed to start: onDeath has said so, or the deadline will
    });
  }

  /** A message from the code frame that is not a reply: the call's result, or a request from its code. @param {any} data */
  #heard(data) {
    const frame = this.code;
    const active = this.active;
    if (!frame || !active || data.job !== active.job) return; // not the call that is running: dropped
    if (data.type === "done") {
      frame.onDone?.(data);
    } else if (data.type === "ask" && Number.isInteger(data.n) && !active.asks.has(data.n)) {
      if (active.asks.size >= MAX_OPEN_ASKS) {
        frame.post({ type: "answer", job: active.job, n: data.n,
          error: `At most ${MAX_OPEN_ASKS} requests (fs, sql) can wait at once: await some before asking for more.` });
        return;
      }
      active.asks.add(data.n);
      void this.#answer(frame, active, data).finally(() => active.asks.delete(data.n));
    }
  }

  /**
   * @param {Frame} frame
   * @param {Active} active
   * @param {{n: number, op: string, args: any}} data
   */
  async #answer(frame, active, { n, op, args }) {
    /** @type {{value?: unknown, error?: string}} */
    let answer;
    try {
      if (op === "readdir") answer = { value: [...DEMO_FILES] };
      else if (op === "readFile") answer = { value: await this.#readFile(String(args?.name)) };
      else if (op === "sql") {
        active.queries.add(n);
        try {
          answer = { value: await this.#sql(active, String(args?.query)) };
        } finally {
          active.queries.delete(n);
        }
      } else answer = { error: "Unknown request." };
    } catch (error) {
      answer = { error: error instanceof Error ? error.message : String(error) };
    }
    if (this.active === active) frame.post({ type: "answer", job: active.job, n, ...answer });
  }

  /** @param {string} name */
  #fetch(name) {
    if (!DEMO_FILES.includes(name)) throw new Error(`There is no file named ${JSON.stringify(name)}. fs.readdir() lists the files.`);
    let bytes = this.bytes.get(name);
    if (!bytes) {
      bytes = fetch(`${this.assets}/${name}`).then((response) => {
        if (!response.ok) throw new Error(`The file ${name} could not be read.`);
        return response.arrayBuffer();
      });
      bytes.catch(() => this.bytes.delete(name)); // try again next time
      this.bytes.set(name, bytes);
    }
    return bytes;
  }

  /** CSV and other text as a string; anything else (Excel) as bytes. @param {string} name */
  async #readFile(name) {
    const bytes = await this.#fetch(name);
    if (bytes.byteLength > MAX_FILE_BYTES) {
      throw new Error(`${name} is too large to read whole (${bytes.byteLength} bytes); query it with sql() instead.`);
    }
    return /\.(csv|tsv|txt|json|md)$/i.test(name) ? new TextDecoder().decode(bytes) : new Uint8Array(bytes.slice(0));
  }

  /**
   * @param {Active} active
   * @param {string} query
   */
  async #sql(active, query) {
    if (!this.database || this.database.dead) {
      this.database = new Frame(`${this.assets}/frames/duckdb.html`, Promise.resolve({ names: DEMO_FILES }), () => {});
    }
    const database = this.database;
    active.used(); // from here on the call has the database: a stop while it starts replaces it
    await database.ready.catch((/** @type {Error} */ error) => {
      throw new Error(`The database could not start: ${error.message}`);
    });
    // The call's first query brings the call's files, once, however many queries start together.
    const first = database.job !== active.job;
    if (first) {
      database.job = active.job;
      database.files = Promise.all(DEMO_FILES.map(async (name) => [name, (await this.#fetch(name)).slice(0)]))
        .then(Object.fromEntries);
    }
    const files = await /** @type {Promise<Record<string, ArrayBuffer>>} */ (database.files);
    if (this.active !== active || database.dead) throw new Error("The call has ended.");
    database.watch(true);
    const reply = await database.request({ type: "sql", job: active.job, query, files: first ? files : undefined })
      .catch((/** @type {Error} */ error) => {
        throw new Error(`The database ${error.message}; the next query starts a fresh one.`);
      });
    if (typeof reply.error === "string") throw new Error(reply.error);
    return reply.rows;
  }

  /**
   * After a call: the database forgets the call's files and connection, or is replaced if it cannot (a query
   * still running, objects left behind, no answer).
   * @param {number} job
   * @param {boolean} used whether the call ran SQL
   * @param {boolean} busy whether a query was still running
   */
  async #tidy(job, used, busy) {
    const database = this.database;
    if (!used || !database || database.dead) return;
    database.watch(false);
    if (busy) {
      database.destroy("a query was still running");
      return;
    }
    const timeout = new Promise((resolve) => setTimeout(() => resolve({ clean: false }), GRACE_MS));
    const reply = await Promise.race([database.request({ type: "end", job }).catch(() => ({ clean: false })), timeout]);
    if (!(/** @type {{clean?: boolean}} */ (reply).clean)) database.destroy("left objects behind");
  }
}
