// The database frame: DuckDB for the sql() of run_js. It runs in <iframe sandbox="allow-scripts">, so it has
// no origin of its own and no cookies, and its policy lets it load DuckDB's own files from snild and nothing
// else. The page gives it one MessageChannel port, once, together with the exact names of the files it may
// read. Before any query runs, DuckDB loads its Excel extension from snild, then allows those names only, turns
// off every other file and network access, and locks its configuration so SQL cannot turn it back on.
//
// A job's files arrive as bytes with the first query that names them, and only they are registered while it
// runs (the names the frame allows are the page's choice; it replaces the frame when they change). Each job
// gets a fresh connection; a job that left tables, views or other objects behind is reported, and the page
// replaces this frame, so nothing one job made is seen by the next.

const MAX_ROWS = 100_000;
const MAX_CHARS = 1_000_000; // the rows of one answer, as JSON: the ceiling on what crosses between frames
const vendor = (path) => new URL(`../vendor/${path}`, location.href).href;
const quote = (text) => `'${String(text).replaceAll("'", "''")}'`;

let port = null;
let db = null;
let conn = null;
let job = null;
let files = [];
let broken = false; // a registration failed halfway: what DuckDB holds is not known, so the page replaces it

async function open(names) {
  const duckdb = await import(vendor("duckdb/duckdb-browser.mjs"));
  const boot = `importScripts(${JSON.stringify(vendor("duckdb/duckdb-browser-eh.worker.js"))});`;
  const url = URL.createObjectURL(new Blob([boot], { type: "text/javascript" }));
  db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(url));
  await db.instantiate(vendor("duckdb/duckdb-eh.wasm"));
  URL.revokeObjectURL(url);
  const setup = await db.connect();
  for (const statement of [
    `SET custom_extension_repository = ${quote(vendor("duckdb-ext"))}`,
    "INSTALL excel",
    "LOAD excel",
    `SET allowed_paths = [${names.map(quote).join(", ")}]`,
    "SET enable_external_access = false",
    "SET lock_configuration = true",
  ]) await setup.query(statement);
  await setup.close();
}

/**
 * A value as plain data, as ordinary code can use it: numbers rather than BigInt (which cannot be added to a
 * number), arrays and objects rather than Arrow lists and structs.
 */
function plain(value) {
  if (typeof value === "bigint") return Number(value);
  if (value === null || typeof value !== "object" || value instanceof Date) return value;
  if (ArrayBuffer.isView(value)) return Array.from(/** @type {any} */ (value), plain);
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value.toJSON === "function") return plain(value.toJSON());
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
}

/** A call's first query: a fresh connection. It counts as begun only once it is there. */
async function begin(id) {
  await finish();
  try {
    conn = await db.connect();
    job = id;
  } catch (error) {
    await finish(); // a half-begun call leaves nothing behind
    throw error;
  }
}

/** Files a query brings that the job does not have yet; a name counts as had only once it is registered. */
async function add(given) {
  for (const [name, bytes] of Object.entries(given || {})) {
    if (files.includes(name)) continue;
    try {
      await db.registerFileBuffer(name, new Uint8Array(bytes));
    } catch (error) {
      broken = true;
      throw error;
    }
    files.push(name);
  }
}

/** Close the job's connection and drop its files; true if it left nothing behind (a file that could not be
 * dropped counts: the page then replaces this frame, so no job's bytes are seen by the next). */
async function finish() {
  if (conn) await conn.close();
  conn = null;
  let dropped = true;
  for (const name of files) await db.dropFile(name).catch(() => { dropped = false; });
  files = [];
  job = null;
  const check = await db.connect();
  try {
    const left = await check.query(`SELECT
      (SELECT count(*) FROM duckdb_tables() WHERE NOT internal)
      + (SELECT count(*) FROM duckdb_views() WHERE NOT internal)
      + (SELECT count(*) FROM duckdb_sequences())
      + (SELECT count(*) FROM duckdb_types() WHERE NOT internal)
      + (SELECT count(*) FROM duckdb_functions() WHERE NOT internal)
      + (SELECT count(*) FROM duckdb_schemas() WHERE NOT internal AND schema_name <> 'main')
      + (SELECT count(*) FROM duckdb_databases() WHERE NOT internal AND database_name <> 'memory') AS n`);
    return dropped && !broken && Number(left.toArray()[0].n) === 0;
  } finally {
    await check.close();
  }
}

/** A decimal as a number: exact when it can be, else the nearest number (beyond 2**53 there is no exact one). */
function decimal(big, scale) {
  const { util } = globalThis.Arrow;
  try {
    return util.bigNumToNumber(big, scale);
  } catch {
    // bigNumToString gives the digits without the scale: put the decimal point in, then round to a number.
    const digits = util.bigNumToString(big);
    const sign = digits.startsWith("-") ? "-" : "";
    const whole = digits.slice(sign.length).padStart(scale + 1, "0");
    return Number(scale ? `${sign}${whole.slice(0, -scale)}.${whole.slice(-scale)}` : `${sign}${whole}`);
  }
}

async function query(text) {
  const table = await conn.query(text);
  if (table.numRows > MAX_ROWS) {
    throw new Error(`The query returned ${table.numRows} rows; at most ${MAX_ROWS} can come back. Aggregate, or add a LIMIT.`);
  }
  // Columns Arrow hands over in a form code cannot use as it is: dates and timestamps (milliseconds) go on as
  // ISO text, as SQL prints them; decimals and 128-bit integers (a sum of integers is one) as numbers.
  const { DataType } = globalThis.Arrow;
  const fix = table.schema.fields.flatMap((field) => {
    const type = field.type;
    if (DataType.isDate(type)) return [[field.name, (ms) => new Date(ms).toISOString().slice(0, 10)]];
    if (DataType.isTimestamp(type)) return [[field.name, (ms) => new Date(ms).toISOString().slice(0, 23)]];
    if (DataType.isDecimal(type)) return [[field.name, (big) => decimal(big, type.scale)]];
    return [];
  });
  const rows = table.toArray().map((row) => {
    const raw = row.toJSON();
    for (const [name, convert] of fix) if (raw[name] !== null && raw[name] !== undefined) raw[name] = convert(raw[name]);
    return plain(raw);
  });
  const size = JSON.stringify(rows).length;
  if (size > MAX_CHARS) {
    throw new Error(`The query returned ${rows.length} rows (${size} characters as JSON); at most ${MAX_CHARS} characters `
      + "can come back. Select fewer columns, aggregate, or add a LIMIT.");
  }
  return rows;
}

async function handle(data) {
  if (data.type === "sql") {
    try {
      if (data.job !== job) await begin(data.job);
      await add(data.files);
      port.postMessage({ type: "reply", n: data.n, rows: await query(String(data.query)) });
    } catch (error) {
      port.postMessage({ type: "reply", n: data.n, error: error instanceof Error ? error.message : String(error) });
    }
  } else if (data.type === "end") {
    let clean = false;
    try {
      clean = data.job === job && (await finish());
    } finally {
      port.postMessage({ type: "reply", n: data.n, clean });
    }
  }
}

addEventListener("message", (event) => {
  // Only the snild page that made this frame, and only once.
  if (port || event.source !== parent || event.data?.type !== "hello" || !event.ports[0]) return;
  port = event.ports[0];
  let queue = open(event.data.names).then(
    () => port.postMessage({ type: "ready" }),
    (error) => port.postMessage({ type: "failed", error: error instanceof Error ? error.message : String(error) }));
  port.onmessage = ({ data }) => {
    if (data?.type === "ping") port.postMessage({ type: "pong" }); // answered at once, even while a query runs
    else queue = queue.then(() => handle(data)).catch(() => {});
  };
});
