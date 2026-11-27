// @ts-check
/**
 * The tools this browser runs for the model, by name. The server offers the model exactly the tools that
 * snild/tools.json marks enabled; a contract test checks that this map holds exactly those.
 *
 * - run_js: the model's JavaScript in the locked frames of runtime/sandbox.js; its result is stored as the
 *   small JSON object of core/runjs.js, within the server's limit on a tool result. Each call gets the files of
 *   the chat it runs in, as they are when it starts.
 * - render_html: a report, from HTML or an .html or .htm file of the chat, cleaned by core/report.js into a standalone
 *   document that runs and loads nothing, saved as a new file of the chat, and shown (onReport).
 */

import { MAX_REPORT_BYTES, cleanReport, removedText, reportResultText } from "../core/report.js";
import { resultText } from "../core/runjs.js";
import { Sandbox, isPdf } from "./sandbox.js";

/**
 * @typedef {import("./sandbox.js").FileSource} FileSource
 * @typedef {import("./sandbox.js").HiddenFile} HiddenFile
 * @typedef {Map<string, import("../core/loop.js").ToolRunner>} Tools
 */

const FILES_WAIT_MS = 10_000; // the chat's list of files, before a call or a preview may start (part of its time)
const SAVE_WAIT_MS = 120_000; // a report being saved (up to 5 MiB)

/**
 * Something a call or a preview waits for before it can start (the chat's files, the report stylesheet), asked
 * for with a signal that ends when Stop is pressed or the wait is over (so an abandoned lookup starts nothing
 * more), and refused if it does not come in time.
 * @template T
 * @param {(signal: AbortSignal) => Promise<T>} lookup
 * @param {AbortSignal | undefined} signal
 * @param {string} [late] what to say if it does not come in time
 * @param {number} [ms] how long it may take
 * @returns {Promise<T>}
 */
function inTime(lookup, signal, late = "The chat's files could not be listed. Try again.", ms = FILES_WAIT_MS) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Stopped", "AbortError"));
  const over = new AbortController();
  return new Promise((resolve, reject) => {
    /** @param {(value: any) => void} settle @param {unknown} value */
    const finish = (settle, value) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      over.abort();
      settle(value);
    };
    const stop = () => finish(reject, signal?.reason ?? new DOMException("Stopped", "AbortError"));
    const timer = setTimeout(() => finish(reject, new Error(late)), ms);
    signal?.addEventListener("abort", stop, { once: true });
    lookup(over.signal).then((source) => finish(resolve, source), (error) => finish(reject, error));
  });
}

/**
 * @param {{assets: string, resultChars: number, files?: (chatId: string, signal: AbortSignal) => Promise<FileSource>,
 *          reportStyle?: string | null, onReport?: (chatId: string, file: import("./sandbox.js").ChatFile) => void}} options
 *   where the frames are served; the most characters a tool result may have (from /bootstrap); a chat's files,
 *   bound to it; the report stylesheet's hash (from /bootstrap); what to do with a report just saved
 * @returns {{tools: Tools, toolsFor: (chat: () => string | null) => Tools, dispose: () => void,
 *            readHidden: (entry: HiddenFile, chatId: string | null, signal?: AbortSignal) =>
 *              Promise<import("./sandbox.js").HiddenText[]>,
 *            reportStyle: () => Promise<{css: string, hash: string}>}}
 *   the tools (toolsFor: for the chat `chat` names when a call starts); how to throw away what they keep in the
 *   page (on signing out); and how the person reads the text hidden in a PDF that a call read (never the code's)
 */
export function browserTools({ assets, resultChars, files, reportStyle = null, onReport = () => {} }) {
  /** @type {Sandbox | null} */
  let sandbox = null; // made when first needed: most chats never run code
  /** @type {Promise<{css: string, hash: string}> | null} */
  let style = null;
  const styleOf = () => {
    // Shared by every report, with a time limit of its own: a request that never ends is dropped, not kept.
    style ??= reportStyle ? fetch(`${assets}/css/report.css`, { signal: AbortSignal.timeout(FILES_WAIT_MS) }).then(async (response) => {
      if (!response.ok) throw new Error("The report stylesheet could not be loaded.");
      // Line ends as the HTML parser gives them, so the style's text matches its hash (taken the same way).
      return { css: (await response.text()).replace(/\r\n?/g, "\n"), hash: /** @type {string} */ (reportStyle) };
    }) : Promise.reject(new Error("Reports are not available here."));
    style.catch(() => {
      style = null; // try again next time
    });
    return style;
  };
  /** @param {string | null} chatId */
  const sourceOf = (chatId) => async (/** @type {AbortSignal} */ signal) => (chatId && files ? files(chatId, signal) : null);
  /** @param {() => string | null} chat */
  const toolsFor = (chat) => new Map([
    ["run_js", /** @type {import("../core/loop.js").ToolRunner} */ (async (call, signal) => {
      sandbox ??= new Sandbox(assets);
      const code = typeof call.input.code === "string" ? call.input.code : "";
      const started = performance.now();
      let source;
      try {
        source = await inTime(sourceOf(chat()), signal);
      } catch (error) {
        if (signal?.aborted) throw error; // Stop: nothing is reported
        return resultText({ status: "error", seconds: 0, error: error instanceof Error ? error.message : String(error) },
          resultChars);
      }
      // The wait for the list is part of the call's time.
      return resultText(await sandbox.run(code, signal, source, performance.now() - started), resultChars);
    })],
    ["render_html", /** @type {import("../core/loop.js").ToolRunner} */ (async (call, signal) => {
      const failed = (/** @type {string} */ error, removed = {}) => reportResultText({ status: "error", error, removed },
        resultChars);
      const named = (/** @type {string} */ name) => (name.length > 200 ? `${name.slice(0, 200)}…` : name);
      const html = typeof call.input.html === "string" ? call.input.html : undefined;
      const file = typeof call.input.file === "string" ? call.input.file : undefined;
      if ((html === undefined) === (file === undefined)) return failed("Give either html or file, not both and not neither.");
      const chatId = chat();
      if (!chatId) return failed("A report is saved in a chat; there is none here.");
      try {
        const source = /** @type {FileSource} */ (await inTime(sourceOf(chatId), signal));
        let text = html ?? "";
        if (file !== undefined) {
          const entry = source.files.find((one) => one.name === file);
          if (!entry) return failed(`There is no file named ${JSON.stringify(named(file))} in this chat.`);
          if (!/\.html?$/i.test(file)) return failed(`${named(file)} is not an .html or .htm file: only those can be shown as a report.`);
          if (entry.size > MAX_REPORT_BYTES) return failed(`${named(file)} is larger than 5 MiB, the most a report may be.`);
          const bytes = await source.fetch(entry.id, signal);
          if (bytes.byteLength > MAX_REPORT_BYTES) return failed(`${named(file)} is larger than 5 MiB, the most a report may be.`);
          if (isPdf(bytes)) return failed(`${named(file)} is a PDF, not a page: read it with pdf.html().`);
          text = new TextDecoder().decode(bytes);
        }
        const style = await inTime(styleOf, signal, "The report stylesheet could not be loaded. Try again.");
        signal?.throwIfAborted();
        const cleaned = cleanReport(text, style);
        if (cleaned.empty) {
          const said = removedText(cleaned.removed);
          return failed(`Nothing is left of the report once cleaned${said ? ` (removed: ${said})` : ""}: write headings, text, `
            + "tables or SVG charts.", cleaned.removed);
        }
        signal?.throwIfAborted();
        const wanted = typeof call.input.name === "string" && call.input.name.trim() ? call.input.name.trim() : "report.html";
        // Saved as sent, even if the call is stopped meanwhile (Stop does not wait for it); shown unless stopped.
        const saving = source.write(/\.html?$/i.test(wanted) ? wanted : `${wanted}.html`,
          /** @type {ArrayBuffer} */ (new TextEncoder().encode(cleaned.document).buffer));
        saving.catch(() => {}); // a save that fails after Stop belongs to no one
        const saved = await inTime(() => saving, signal, "The report could not be saved in time. Try again.", SAVE_WAIT_MS);
        signal?.throwIfAborted();
        onReport(chatId, saved);
        return reportResultText({ status: "ok", file: saved.name, id: saved.id, title: cleaned.title,
          tables: cleaned.tables, charts: cleaned.charts, removed: cleaned.removed }, resultChars);
      } catch (error) {
        if (signal?.aborted) throw error; // Stop: nothing is reported
        return failed(error instanceof Error ? error.message : String(error));
      }
    })],
  ]);
  return {
    tools: toolsFor(() => null),
    toolsFor,
    reportStyle: styleOf,
    dispose: () => sandbox?.dispose(),
    readHidden: async (entry, chatId, signal) => {
      const started = performance.now();
      const source = entry.id ? await inTime(sourceOf(chatId), signal) : null; // a demo PDF needs no list
      // The wait for the list is part of the preview's time, as it is of a call's.
      return (sandbox ??= new Sandbox(assets)).readHidden(entry, source, signal, performance.now() - started);
    },
  };
}
