// @ts-check
/**
 * The tools this browser runs for the model, by name. The server offers the model exactly the tools that
 * snild/tools.json marks enabled; a contract test checks that this map holds exactly those.
 *
 * - run_js: the model's JavaScript in the locked frames of runtime/sandbox.js; its result is stored as the
 *   small JSON object of core/runjs.js, within the server's limit on a tool result.
 */

import { resultText } from "../core/runjs.js";
import { Sandbox } from "./sandbox.js";

/**
 * @param {{assets: string, resultChars: number}} options where the frames are served, and the most characters a
 *   tool result may have (from /bootstrap)
 * @returns {{tools: Map<string, import("../core/loop.js").ToolRunner>, dispose: () => void}} the tools, and how
 *   to throw away what they keep in the page (on signing out)
 */
export function browserTools({ assets, resultChars }) {
  /** @type {Sandbox | null} */
  let sandbox = null; // made on the first call: most chats never run code
  const tools = new Map([
    ["run_js", /** @type {import("../core/loop.js").ToolRunner} */ (async (call, signal) => {
      sandbox ??= new Sandbox(assets);
      const code = typeof call.input.code === "string" ? call.input.code : "";
      return resultText(await sandbox.run(code, signal), resultChars);
    })],
  ]);
  return { tools, dispose: () => sandbox?.dispose() };
}
