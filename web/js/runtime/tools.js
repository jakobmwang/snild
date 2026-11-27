// @ts-check
/**
 * The tools this browser runs for the model, by name. The server offers the model exactly the tools that
 * snild/tools.json marks enabled; a contract test checks that this map holds exactly those.
 *
 * - run_js: the model's JavaScript in the locked frames of runtime/sandbox.js; its result is stored as the
 *   small JSON object of core/runjs.js, within the server's limit on a tool result. Each call gets the files of
 *   the chat it runs in, as they are when it starts.
 */

import { resultText } from "../core/runjs.js";
import { Sandbox } from "./sandbox.js";

/**
 * @typedef {import("./sandbox.js").FileSource} FileSource
 * @typedef {import("./sandbox.js").HiddenFile} HiddenFile
 * @typedef {Map<string, import("../core/loop.js").ToolRunner>} Tools
 */

const FILES_WAIT_MS = 10_000; // the chat's list of files, before a call or a preview may start (part of its time)

/**
 * The chat's files for a call or a preview, asked for with a signal that ends when Stop is pressed or the wait
 * is over (so an abandoned lookup starts nothing more), and refused if the list does not come in time.
 * @param {(signal: AbortSignal) => Promise<FileSource | null>} lookup
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<FileSource | null>}
 */
function inTime(lookup, signal) {
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
    const timer = setTimeout(() => finish(reject, new Error("The chat's files could not be listed. Try again.")),
      FILES_WAIT_MS);
    signal?.addEventListener("abort", stop, { once: true });
    lookup(over.signal).then((source) => finish(resolve, source), (error) => finish(reject, error));
  });
}

/**
 * @param {{assets: string, resultChars: number, files?: (chatId: string, signal: AbortSignal) => Promise<FileSource>}} options where the
 *   frames are served; the most characters a tool result may have (from /bootstrap); a chat's files, bound to it
 * @returns {{tools: Tools, toolsFor: (chat: () => string | null) => Tools, dispose: () => void,
 *            readHidden: (entry: HiddenFile, chatId: string | null, signal?: AbortSignal) =>
 *              Promise<import("./sandbox.js").HiddenText[]>}}
 *   the tools (toolsFor: for the chat `chat` names when a call starts); how to throw away what they keep in the
 *   page (on signing out); and how the person reads the text hidden in a PDF that a call read (never the code's)
 */
export function browserTools({ assets, resultChars, files }) {
  /** @type {Sandbox | null} */
  let sandbox = null; // made when first needed: most chats never run code
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
  ]);
  return {
    tools: toolsFor(() => null),
    toolsFor,
    dispose: () => sandbox?.dispose(),
    readHidden: async (entry, chatId, signal) => {
      const started = performance.now();
      const source = entry.id ? await inTime(sourceOf(chatId), signal) : null; // a demo PDF needs no list
      // The wait for the list is part of the preview's time, as it is of a call's.
      return (sandbox ??= new Sandbox(assets)).readHidden(entry, source, signal, performance.now() - started);
    },
  };
}
