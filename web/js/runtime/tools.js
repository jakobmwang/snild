// @ts-check
/**
 * The tools this browser can run for the model, by name. The server offers the model exactly the tools that
 * snild/tools.json marks enabled; a contract test checks that this map holds exactly those. None exist yet:
 * run_js, render_html and fetch_url are planned.
 *
 * @type {Map<string, import("../core/loop.js").ToolRunner>}
 */
export const browserTools = new Map();
