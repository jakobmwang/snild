// @ts-check
/**
 * What a run_js call leaves in the chat: one tool_result whose text is a small, versioned JSON object, so the
 * model reads it and the chat can draw it again after a reload. It always fits the server's limit on a tool
 * result: an SVG that does not fit is left out whole (never cut in the middle), then the longest text is cut
 * until the rest fits, and a note says what was cut.
 *
 *   {"run_js": 1, "status": "ok" | "error", "seconds": 0.42, "error": "...", "note": "...",
 *    "value": "...", "console": "...", "svg": "<svg ...>"}
 */

const RESULT_VERSION = 1;
const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * @typedef {{run_js: number, status: "ok" | "error", seconds: number, error?: string, note?: string,
 *            value?: string, console?: string, svg?: string}} RunJsResult
 */

/**
 * @param {import("../runtime/sandbox.js").RunOutcome} outcome
 * @param {number} limit the most characters the result may have
 * @returns {{content: string, is_error: boolean}}
 */
export function resultText(outcome, limit) {
  // Text from the code may hold half a surrogate pair, which JSON keeps but an encoder throws on: made whole here.
  const clean = (/** @type {string | undefined} */ text) => (text === undefined ? undefined : text.toWellFormed());
  /** @type {Record<"error" | "value" | "console", string | undefined>} */
  const texts = { error: clean(outcome.error || undefined), value: clean(outcome.value), console: clean(outcome.console || undefined) };
  /** @type {string[]} */
  const notes = [];
  if (outcome.svgChars) notes.push(tooLarge(outcome.svgChars));
  let svg = outcome.svg ? withNamespace(clean(outcome.svg) ?? "") : undefined;

  /** The result with every text cut to at most `cap` characters (from its start), and notes on what was cut. */
  const build = (/** @type {number} */ cap) => {
    const cut = (/** @type {"error" | "value" | "console"} */ key) => {
      const text = texts[key];
      if (text === undefined || text.length <= cap) return text;
      return `${text.slice(0, cap).toWellFormed()}\n[... ${text.length - cap} more characters cut]`;
    };
    const long = /** @type {const} */ (["error", "value", "console"]).filter((key) => (texts[key]?.length ?? 0) > cap);
    const said = [...notes, ...long.map((key) => `The ${key} was too long and was cut.`)];
    /** @type {RunJsResult} */
    const result = { run_js: RESULT_VERSION, status: outcome.status, seconds: outcome.seconds };
    if (texts.error !== undefined) result.error = cut("error");
    if (said.length) result.note = said.join(" ");
    if (texts.value !== undefined) result.value = cut("value");
    if (texts.console !== undefined) result.console = cut("console");
    if (svg) result.svg = svg;
    return JSON.stringify(result);
  };

  const whole = Math.max(texts.error?.length ?? 0, texts.value?.length ?? 0, texts.console?.length ?? 0);
  let content = build(whole);
  if (svg && content.length > limit) { // a chart is kept whole or not at all
    notes.push(tooLarge(svg.length));
    svg = undefined;
    content = build(whole);
  }
  if (content.length > limit) {
    // The longest cap at which everything fits: shorter texts stay whole, longer ones are cut to the same length.
    let fits = 0;
    let fails = whole;
    while (fails - fits > 1) {
      const cap = Math.floor((fits + fails) / 2);
      if (build(cap).length <= limit) fits = cap;
      else fails = cap;
    }
    content = build(fits);
    if (content.length > limit) { // only with a limit too small for even the cut markers
      content = JSON.stringify({ run_js: RESULT_VERSION, status: outcome.status, seconds: outcome.seconds,
        note: "The result was too large to keep." });
    }
  }
  return { content, is_error: outcome.status !== "ok" };
}

/** @param {number} chars */
function tooLarge(chars) {
  return `The returned SVG (${chars} characters) was too large to keep: draw fewer elements, or return numbers.`;
}

/** An SVG an <img> can show: it needs its namespace. @param {string} svg */
export function withNamespace(svg) {
  return /^<svg\b(?![^>]*\sxmlns=)/.test(svg) ? svg.replace(/^<svg\b/, `<svg xmlns="${SVG_NS}"`) : svg;
}

/**
 * A stored run_js result, or null if the text is not one (an error the server wrote, or a result from another
 * version).
 * @param {string} content
 * @returns {RunJsResult | null}
 */
export function parseResult(content) {
  if (!content.startsWith("{")) return null;
  try {
    const result = JSON.parse(content);
    const ok = result && result.run_js === RESULT_VERSION && (result.status === "ok" || result.status === "error")
      && typeof result.seconds === "number"
      && ["error", "note", "value", "console", "svg"].every((key) => result[key] === undefined || typeof result[key] === "string");
    return ok ? result : null;
  } catch {
    return null;
  }
}
