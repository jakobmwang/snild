// @ts-check
/**
 * Where run_js runs: three locked frames (web/frames/), made when first needed and kept warm.
 *
 * - The code frame runs the model's JavaScript in a fresh worker per call. Its policy names no address: the
 *   code can load and send nothing, anywhere. This page hands it d3 and linkedom as text.
 * - The database frame runs DuckDB for the code's sql(); it reads only the files this page hands it.
 * - The PDF frame reads PDFs with digpdf for the code's pdf.html(); it gets each PDF's bytes from this page.
 *   Text hidden on a PDF's pages never reaches the code: the call's result only names the files that had some,
 *   and the person can look at it (readHidden) and add it to their own message. A PDF's raw bytes never reach
 *   the code either (fs.readFile refuses one, and none is handed to DuckDB, whose read_blob would return it).
 *
 * The files a call can use are the chat's (a FileSource bound to the chat the call runs in, taken when it
 * starts) and the demo files. This page fetches the bytes a call reads, within budgets per call, and saves what
 * the code writes to the chat, so a write lands even when the call ends just after.
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
const MiB = 1024 * 1024;
const MAX_READ_BYTES = 5 * MiB;   // fs.readFile takes a file whole up to this size (bigger tables: sql())
const MAX_PDF_BYTES = 25 * MiB;   // pdf.html (its HTML is capped separately, in the PDF frame)
const MAX_CALL_BYTES = 100 * MiB; // chat files one call fetches in all, each file counted once
const MAX_SQL_BYTES = 50 * MiB;   // of which handed to DuckDB
const MAX_WRITES = 20;            // fs.writeFile calls in one call
const MAX_WRITE_BYTES = 25 * MiB; // and their bytes together
const MAX_OPEN_ASKS = 8;    // requests (fs, sql, pdf) one call may have waiting at once
const TABLE = /\.(csv|tsv|xlsx)$/i; // what DuckDB reads
const TEXT = /\.(csv|tsv|txt|json|md|html|xml|svg)$/i; // what fs.readFile gives as text

/** The files every chat can use, served with the page. */
const DEMO_FILES = ["demo/sales.csv", "demo/sales.xlsx", "demo/report.pdf"];
/** A PDF's digest as digpdf records it: what tells one file from another under the same name. */
const SOURCE = /^sha256:[0-9a-f]{64}$/;
/** The demo files DuckDB reads: what sql() registers when the code names no files. */
const TABLE_FILES = DEMO_FILES.filter((name) => TABLE.test(name));

/**
 * What a call came to. `value` is the code's return value as text, `svg` a returned SVG chart, `hidden` the PDFs
 * whose hidden text was kept from the code (how many elements, and the PDF's digest).
 * @typedef {{file: string, elements: number, source: string, id?: string}} HiddenFile   id: a chat file's
 * @typedef {{status: "ok" | "error", seconds: number, value?: string, svg?: string, svgChars?: number,
 *            console?: string, error?: string, hidden?: HiddenFile[]}} RunOutcome
 * @typedef {{page: number | null, kind: string, bbox: string, text: string}} HiddenText
 * @typedef {import("../core/protocol.js").ChatFile} ChatFile
 * @typedef {{files: ChatFile[], fetch: (id: string, signal?: AbortSignal) => Promise<ArrayBuffer>,
 *            write: (name: string, bytes: ArrayBuffer) => Promise<ChatFile>}} FileSource
 *   The chat a call runs in: its files when the call started, how to fetch one, how to add one.
 * @typedef {{job: number, queries: Set<number>, reads: Set<number>, asks: Set<number>, used: () => void,
 *            hidden: Map<string, HiddenFile>, source: FileSource | null, files: ChatFile[], tables: string[],
 *            over: AbortController, cache: Map<string, Promise<ArrayBuffer>>, fetched: number,
 *            sql: Map<string, Promise<ArrayBuffer>>, sqlBytes: number, sent: Set<string>, writes: number,
 *            written: number}} Active
 *   files: the chat's files (and those written in the call); tables: the names sql() may register; cache: the
 *   bytes fetched, by file id (each counted once against fetched); sql: table bytes by name; sent: the names
 *   the database frame already has for this call; over: aborts what the call still fetches once it ends.
 */

/** Whether bytes are a PDF: its header may come after up to 1 KB of anything. @param {ArrayBuffer} bytes */
export function isPdf(bytes) {
  return new TextDecoder("latin1").decode(new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 1024))).includes("%PDF-");
}

/** A size as people read it. @param {number} bytes */
function mib(bytes) {
  return bytes >= MiB ? `${(bytes / MiB).toFixed(1).replace(/\.0$/, "")} MiB` : `${Math.ceil(bytes / 1024)} KiB`;
}

/** @param {string} name */
function pdfRefused(name) {
  return new Error(`${name} is a PDF: read it with pdf.html(). Its raw bytes are not handed to code.`);
}

/** @param {string} name @param {number} size */
function tooLargeToRead(name, size) {
  return new Error(`${name} is too large to read whole (${mib(size)}; at most ${mib(MAX_READ_BYTES)}). `
    + "Query a table with sql() instead.");
}

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
    this.job = 0; // the call the database frame works for
    this.names = ""; // the database frame: the file names it allows, one per line
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

  /** @param {Record<string, unknown>} message @param {Transferable[]} [transfer] buffers handed over, not copied */
  post(message, transfer = []) {
    if (!this.dead) this.port.postMessage(message, transfer);
  }

  /**
   * Send a message and wait for its reply.
   * @param {Record<string, unknown>} message
   * @param {Transferable[]} [transfer] buffers handed over rather than copied
   * @returns {Promise<any>}
   */
  request(message, transfer = []) {
    if (this.dead) return Promise.reject(new Error(this.dead));
    const n = ++this.next;
    return new Promise((resolve, reject) => {
      this.waiting.set(n, { resolve, reject });
      this.port.postMessage({ ...message, n }, transfer);
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
    /** @type {Frame | null} */
    this.reader = null;
    this.disposed = false;
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
   * @param {FileSource | null} [source] the chat's files (none: only the demo files)
   * @param {number} [spentMs] time the call already spent (waiting for the chat's files): its deadline is shorter
   * @returns {Promise<RunOutcome>}
   */
  run(code, signal, source = null, spentMs = 0) {
    const turn = this.queue.then(() => this.#job(code, signal, source, spentMs));
    this.queue = turn.catch(() => {});
    return turn;
  }

  /** Throw the frames away (signing out): nothing of this person's stays in the page, and nothing starts again. */
  dispose() {
    this.disposed = true;
    this.code?.destroy("closed");
    this.database?.destroy("closed");
    this.reader?.destroy("closed");
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
   * @param {FileSource | null} source
   * @param {number} spentMs
   * @returns {Promise<RunOutcome>}
   */
  #job(code, signal, source, spentMs) {
    signal?.throwIfAborted();
    const job = ++this.jobs;
    const started = performance.now();
    if (!this.code || this.code.dead) {
      this.code = new Frame(`${this.assets}/frames/code.html`, this.#libraries(), (data) => this.#heard(data));
    }
    const frame = this.code;
    let usedDatabase = false;
    const files = [...(source?.files ?? [])];
    /** @type {Active} */
    const active = { job, queries: new Set(), reads: new Set(), asks: new Set(), used: () => { usedDatabase = true; },
      hidden: new Map(), source, files, tables: files.filter((file) => TABLE.test(file.name)).map((file) => file.name),
      over: new AbortController(), cache: new Map(), fetched: 0, sql: new Map(), sqlBytes: 0, sent: new Set(),
      writes: 0, written: 0 };
    this.active = active;

    return new Promise((resolve, reject) => {
      let over = false;
      /** @type {ReturnType<typeof setTimeout> | 0} */
      let grace = 0;
      const timer = setTimeout(() => cancel(`The code was stopped after ${Math.round(this.deadlineMs / 1000)} s, `
        + "its time limit. Make it do less, or work on less data at once."), Math.max(0, this.deadlineMs - spentMs));

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
        active.over.abort(); // files still on their way belong to no one now
        this.#tidyReader(active.reads.size > 0);
        await this.#tidy(job, usedDatabase, active.queries.size > 0);
        settle();
      };
      const seconds = () => Math.round((performance.now() - started) / 10) / 100;
      /** @param {Omit<RunOutcome, "seconds">} outcome */
      const finish = (outcome) => void close(() => resolve({ ...outcome, seconds: seconds(),
        ...(active.hidden.size ? { hidden: [...active.hidden.values()] } : {}) }));
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
        // The other frames may have shared the frame's process (Chrome puts frames of one site together), and so
        // its end: one that does not answer goes too, before the next call could send it work.
        await Promise.all([this.database, this.reader].map(async (other) => {
          if (other && !other.dead && !(await other.alive(1000))) other.destroy("stopped responding");
        }));
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
          error: `At most ${MAX_OPEN_ASKS} requests (fs, sql, pdf) can wait at once: await some before asking for more.` });
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
      if (op === "readdir") answer = { value: [...active.files.map((file) => file.name), ...DEMO_FILES] };
      else if (op === "readFile") answer = { value: await this.#readFile(active, String(args?.name)) };
      else if (op === "writeFile") answer = { value: await this.#writeFile(active, String(args?.name), args?.bytes) };
      else if (op === "sql") {
        active.queries.add(n);
        try {
          const files = Array.isArray(args?.files) ? args.files.map(String) : null;
          answer = { value: await this.#sql(active, String(args?.query), files) };
        } finally {
          active.queries.delete(n);
        }
      } else if (op === "pdf") {
        active.reads.add(n); // before any wait: a call that ends meanwhile finds the read and ends it
        try {
          answer = { value: await this.#pdf(active, String(args?.name)) };
        } finally {
          active.reads.delete(n);
        }
      } else answer = { error: "Unknown request." };
    } catch (error) {
      answer = { error: error instanceof Error ? error.message : String(error) };
    }
    const transfer = answer.value instanceof Uint8Array ? [answer.value.buffer] : []; // a copy made for this answer
    if (this.active === active) frame.post({ type: "answer", job: active.job, n, ...answer }, transfer);
  }

  /** A demo file's bytes, fetched once for the page. @param {string} name */
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

  /** The chat's file of that name in this call, or null (a demo file, or none). @param {Active} active @param {string} name */
  #chatFile(active, name) {
    return active.files.find((file) => file.name === name) ?? null;
  }

  /**
   * A file's bytes for this call: a demo file, or one of the chat's, fetched once per call and counted once
   * against the call's budget before it is fetched.
   * @param {Active} active
   * @param {string} name
   * @returns {Promise<ArrayBuffer>}
   */
  async #bytes(active, name) {
    const file = this.#chatFile(active, name);
    if (!file) return this.#fetch(name);
    let bytes = active.cache.get(file.id);
    if (!bytes) {
      if (active.fetched + file.size > MAX_CALL_BYTES) {
        throw new Error(`One call can read at most ${mib(MAX_CALL_BYTES)} of files; ${name} would pass that. `
          + "Read fewer or smaller files in one call.");
      }
      active.fetched += file.size;
      const source = /** @type {FileSource} */ (active.source);
      bytes = source.fetch(file.id, active.over.signal).catch((/** @type {Error} */ error) => {
        active.cache.delete(file.id); // not read: it costs nothing, and a later read tries again
        active.fetched -= file.size;
        throw new Error(active.over.signal.aborted ? "The call has ended."
          : `${name} could not be read${error?.message ? `: ${error.message}` : "."}`);
      });
      active.cache.set(file.id, bytes);
    }
    return bytes;
  }

  /**
   * Save what the code wrote to the chat, under the name it asked for or, if that is taken, a numbered one
   * ("a (2).csv"), which it gets back. Within the call's limits; none starts once the call has ended, and one
   * already sent lands even if the call ends meanwhile.
   * @param {Active} active
   * @param {string} name
   * @param {unknown} bytes
   */
  async #writeFile(active, name, bytes) {
    if (!(bytes instanceof ArrayBuffer)) throw new Error("fs.writeFile takes a string, a Uint8Array or an ArrayBuffer.");
    if (!active.source) throw new Error("Files can be written only in a chat.");
    if (active.writes >= MAX_WRITES) throw new Error(`One call can write at most ${MAX_WRITES} files.`);
    if (active.written + bytes.byteLength > MAX_WRITE_BYTES) {
      throw new Error(`One call can write at most ${mib(MAX_WRITE_BYTES)} in all.`);
    }
    if (this.active !== active) throw new Error("The call has ended.");
    active.writes++;
    active.written += bytes.byteLength;
    const file = await active.source.write(name, bytes);
    active.files.unshift(file); // readable by the rest of this call (but not by sql(), whose files were fixed at its start)
    active.cache.set(file.id, Promise.resolve(bytes));
    return file.name;
  }

  /**
   * A PDF as HTML, read by digpdf in the PDF frame, which is started on the first read and kept warm.
   * @param {Active} active
   * @param {string} name
   * @returns {Promise<{html: string, notes: string[]}>}
   */
  async #pdf(active, name) {
    const file = this.#chatFile(active, name);
    if (file && file.size > MAX_PDF_BYTES) throw new Error(`${name} is too large to read (${mib(file.size)}; at most ${mib(MAX_PDF_BYTES)}).`);
    const bytes = await this.#bytes(active, name);
    if (this.active !== active) throw new Error("The call has ended."); // no frame is started for an ended call
    if (bytes.byteLength > MAX_PDF_BYTES) throw new Error(`${name} is too large to read (${mib(bytes.byteLength)}).`);
    const reader = await this.#reader();
    if (this.active !== active || reader.dead) throw new Error("The call has ended.");
    const copy = bytes.slice(0);
    const reply = await this.#ask(reader, { type: "pdf", name, bytes: copy }, [copy]);
    if (this.active !== active) throw new Error("The call has ended.");
    const elements = Number(reply.hidden) || 0;
    const source = String(reply.source ?? "");
    if (elements > 0 && SOURCE.test(source)) {
      active.hidden.set(name, { file: name, elements, source, ...(file ? { id: file.id } : {}) });
    }
    return { html: String(reply.html), notes: Array.isArray(reply.notes) ? reply.notes.map(String) : [] };
  }

  /**
   * The text hidden in a PDF, for the person to look at: read by this page and never handed to code. It takes
   * its turn after any call (as a call does), so the two never share the PDF frame. `entry.source` is the
   * digest of the PDF the call read; another file now under that name is refused. A chat file is found by its
   * id in `files` (the chat's, now): one deleted meanwhile is no longer there. `signal`: the person left the chat.
   * @param {HiddenFile} entry
   * @param {FileSource | null} files
   * @param {AbortSignal} [signal]
   * @param {number} [spentMs] time already spent (finding the chat's files): the preview's deadline is shorter
   * @returns {Promise<HiddenText[]>}
   */
  readHidden(entry, files, signal, spentMs = 0) {
    const turn = this.queue.then(() => this.#readHidden(entry, files, signal, spentMs));
    this.queue = turn.catch(() => {});
    return turn;
  }

  /**
   * @param {HiddenFile} entry @param {FileSource | null} files @param {AbortSignal | undefined} signal
   * @param {number} spentMs
   * @returns {Promise<HiddenText[]>}
   */
  async #readHidden({ file: name, id, source }, files, signal, spentMs) {
    signal?.throwIfAborted();
    if (!SOURCE.test(source)) throw new Error(`Which version of ${name} the code read is not known.`);
    if (id) { // a chat file: still there, and the very file the call read (digpdf's source is its SHA-256)
      const listed = files?.files.find((file) => file.id === id);
      if (!listed) throw new Error(`${name} is no longer in this chat.`);
      if (`sha256:${listed.sha256}` !== source) throw new Error(`${name} has changed since the code read it.`);
    }
    // The PDF frame is this preview's from the moment it asks for it (no call runs meanwhile), so when time runs
    // out or the person leaves, the frame goes with it, started or not: digpdf cannot be interrupted, and its
    // answer would belong to no one. A stopped preview touches nothing after its next wait.
    let stopped = false;
    let usesReader = false;
    /** @type {(error: Error) => void} */
    let fail = () => {};
    const over = new Promise((_, reject) => { fail = reject; });
    /** @param {Error} error */
    const fetching = new AbortController(); // the file's download, called off with the preview
    const stop = (error) => {
      stopped = true;
      fetching.abort();
      if (usesReader) this.reader?.destroy(error.message);
      fail(error);
    };
    const timer = setTimeout(() => stop(new Error("The PDF reader did not answer in time.")),
      Math.max(0, this.deadlineMs - spentMs));
    const leave = () => stop(new DOMException("The chat was closed.", "AbortError"));
    signal?.addEventListener("abort", leave, { once: true });
    const read = async () => {
      const bytes = id ? await /** @type {FileSource} */ (files).fetch(id, fetching.signal) : await this.#fetch(name);
      if (stopped) return [];
      if (bytes.byteLength > MAX_PDF_BYTES || !isPdf(bytes)) throw new Error(`${name} cannot be read as a PDF.`);
      usesReader = true;
      const reader = await this.#reader();
      if (stopped || reader.dead) return [];
      const copy = bytes.slice(0);
      const reply = await this.#ask(reader, { type: "pdf", name, bytes: copy, hidden: true }, [copy]);
      if (reply.source !== source) throw new Error(`${name} has changed since the code read it.`);
      return Array.isArray(reply.hidden) ? reply.hidden : [];
    };
    try {
      return await Promise.race([read(), over]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", leave);
      if (usesReader) this.reader?.watch(false); // no call runs meanwhile: this was the frame's only work
    }
  }

  /** The PDF frame, started on the first read and kept warm. @returns {Promise<Frame>} */
  async #reader() {
    if (this.disposed) throw new Error("The PDF reader is closed.");
    if (!this.reader || this.reader.dead) {
      this.reader = new Frame(`${this.assets}/frames/pdf.html`, Promise.resolve({}), () => {});
    }
    const reader = this.reader;
    await reader.ready.catch((/** @type {Error} */ error) => {
      throw new Error(`The PDF reader could not start: ${error.message}`);
    });
    return reader;
  }

  /**
   * One request to the PDF frame, watched while it runs.
   * @param {Frame} reader
   * @param {Record<string, unknown>} message
   * @param {Transferable[]} [transfer]
   */
  async #ask(reader, message, transfer) {
    reader.watch(true);
    const reply = await reader.request(message, transfer).catch((/** @type {Error} */ error) => {
      throw new Error(`The PDF reader ${error.message}; the next read starts a fresh one.`);
    });
    if (typeof reply.error === "string") throw new Error(reply.error);
    return reply;
  }

  /**
   * CSV and other text as a string; anything else (Excel) as bytes. A PDF is refused: its raw bytes would let the
   * code dig out the text hidden on its pages.
   * @param {Active} active
   * @param {string} name
   */
  async #readFile(active, name) {
    const file = this.#chatFile(active, name);
    if (/\.pdf$/i.test(name)) throw pdfRefused(name);
    if (file && file.size > MAX_READ_BYTES) throw tooLargeToRead(name, file.size);
    const bytes = await this.#bytes(active, name);
    if (isPdf(bytes)) throw pdfRefused(name);
    if (bytes.byteLength > MAX_READ_BYTES) throw tooLargeToRead(name, bytes.byteLength);
    return TEXT.test(name) ? new TextDecoder().decode(bytes) : new Uint8Array(bytes.slice(0));
  }

  /**
   * The bytes of the table files a query names, fetched once per call and checked: a PDF is never handed to
   * DuckDB. The sizes of the chat files not yet in hand are set aside from the call's SQL budget together,
   * before any is fetched; a file that fails to load, or turns out to be a PDF, gives its share back (a PDF
   * still counts against the call's fetches).
   * @param {Active} active
   * @param {string[]} names
   * @returns {Promise<ArrayBuffer[]>}
   */
  #tableBytes(active, names) {
    const fresh = names.filter((name) => !active.sql.has(name));
    const sizes = fresh.map((name) => this.#chatFile(active, name)?.size ?? 0);
    if (active.sqlBytes + sizes.reduce((sum, size) => sum + size, 0) > MAX_SQL_BYTES) {
      return Promise.reject(new Error(`sql() can use at most ${mib(MAX_SQL_BYTES)} of files in one call; these files `
        + "would pass that."));
    }
    // And the call's whole budget, before any of them is fetched: a batch is refused whole, never halfway.
    const unfetched = fresh.map((name) => this.#chatFile(active, name)).filter((file) => file && !active.cache.has(file.id));
    if (active.fetched + unfetched.reduce((sum, file) => sum + (file?.size ?? 0), 0) > MAX_CALL_BYTES) {
      return Promise.reject(new Error(`One call can read at most ${mib(MAX_CALL_BYTES)} of files; these files would `
        + "pass that."));
    }
    fresh.forEach((name, i) => {
      active.sqlBytes += sizes[i];
      const bytes = this.#bytes(active, name).then((got) => {
        if (isPdf(got)) throw new Error(`${name} is a PDF, not a table: read it with pdf.html().`);
        return got;
      });
      bytes.catch(() => {
        active.sqlBytes -= sizes[i];
        active.sql.delete(name);
      });
      active.sql.set(name, bytes);
    });
    return Promise.all(names.map((name) => /** @type {Promise<ArrayBuffer>} */ (active.sql.get(name))));
  }

  /**
   * A query in the database frame, over the files it names (by default the demo tables). The frame allows
   * exactly the table files of the call's chat and the demo tables; one that allows others is replaced. Each
   * file goes to the frame once per call, with the first query that needs it.
   * @param {Active} active
   * @param {string} query
   * @param {string[] | null} files
   */
  async #sql(active, query, files) {
    const wanted = [...new Set(files ?? TABLE_FILES)];
    for (const name of wanted) {
      if (!TABLE_FILES.includes(name) && !active.tables.includes(name)) {
        throw new Error(`${JSON.stringify(name)} is not a table file (CSV, TSV or Excel) of this chat as the call `
          + "started. fs.readdir() lists the files.");
      }
    }
    const names = [...TABLE_FILES, ...active.tables].join("\n");
    if (this.database && !this.database.dead && this.database.names !== names) {
      this.database.destroy("its files changed"); // its allowed paths are locked when it starts
    }
    if (!this.database || this.database.dead) {
      this.database = new Frame(`${this.assets}/frames/duckdb.html`,
        Promise.resolve({ names: names.split("\n") }), () => {});
      this.database.names = names;
      active.sent.clear(); // a frame made during the call (its first died) has none of its files
    }
    const database = this.database;
    active.used(); // from here on the call has the database: a stop while it starts replaces it
    const [, bytes] = await Promise.all([
      database.ready.catch((/** @type {Error} */ error) => {
        throw new Error(`The database could not start: ${error.message}`);
      }),
      this.#tableBytes(active, wanted),
    ]);
    if (this.active !== active || database.dead) throw new Error("The call has ended.");
    /** @type {Record<string, ArrayBuffer>} */
    const given = {};
    wanted.forEach((name, i) => {
      if (active.sent.has(name)) return; // an earlier query of this call brought it
      active.sent.add(name);
      given[name] = bytes[i].slice(0);
    });
    database.watch(true);
    const reply = await database.request({ type: "sql", job: active.job, query, files: given }, Object.values(given))
      .catch((/** @type {Error} */ error) => ({ error: `The database ${error.message}; the next query starts a fresh one.` }));
    if (typeof reply.error === "string") {
      // The files may not have been registered: a later query of the call sends them again (the frame skips
      // the ones it has).
      for (const name of Object.keys(given)) active.sent.delete(name);
      throw new Error(reply.error);
    }
    return reply.rows;
  }

  /**
   * After a call: the PDF frame rests, or is replaced if a read is still under way (digpdf cannot be
   * interrupted, and its answer would belong to no one).
   * @param {boolean} busy
   */
  #tidyReader(busy) {
    const reader = this.reader;
    if (!reader || reader.dead) return;
    reader.watch(false);
    if (busy) reader.destroy("a PDF was still being read");
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
