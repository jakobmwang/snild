// What every browser test shares: where snild runs, how to reach its admin command, and signed-in pages.
//
//   SNILD_TEST_INSTANCE=1  required: the tests add accounts (alice, bob, …) and reset their passwords, so
//                  they run only against a disposable instance
//   SNILD_URL      the origin to test (default http://127.0.0.1:8080); CI also tests a non-loopback http
//                  origin, which is not a secure context
//   SNILD_ADMIN    how to run snild-admin (default: docker compose exec -T snild snild-admin)
//   SNILD_RESTART  how to restart snild (default: docker compose restart snild)
//   SNILD_LOGS     how to read snild's log (default: docker compose logs snild)
//   SNILD_EXPECT_SETUP=1  the instance is fresh: the setup test fails instead of skipping (CI)
//   SNILD_CHROME   the Chrome binary (see cdp.js)
//   SNILD_SHOTS    a folder for screenshots of failures (optional)

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { Browser } from "./cdp.js";

if (process.env.SNILD_TEST_INSTANCE !== "1") {
  throw new Error("The browser tests add accounts to the snild they test and reset their passwords. Run them "
    + "only against a disposable instance, and say so with SNILD_TEST_INSTANCE=1.");
}

export const BASE = (process.env.SNILD_URL || "http://127.0.0.1:8080").replace(/\/$/, "");

/**
 * The password of every account this test file uses, made at random for this process and never written to
 * disk. Each test file runs in its own process, and addPerson gives its people this password.
 */
export const PASSWORD = randomBytes(18).toString("base64url");
const givenPassword = new Set();
const ADMIN = process.env.SNILD_ADMIN || "docker compose exec -T snild snild-admin";
const RESTART = process.env.SNILD_RESTART || "docker compose restart snild";
const LOGS = process.env.SNILD_LOGS || "docker compose logs snild";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run snild-admin with the given arguments (and a password on standard input, if given). */
export function admin(args, input = undefined) {
  return execSync(`${ADMIN} ${args}`, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

/** The setup code snild announced last in its log, as a person setting it up would read it. */
export function loggedSetupCode() {
  const log = execSync(LOGS, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return [...log.matchAll(/enter the setup code ([A-Za-z0-9_-]+)/g)].at(-1)?.[1] ?? null;
}

export function restartServer() {
  execSync(RESTART, { stdio: "ignore" });
}

export async function waitForServer(timeout = 60_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/v1/health`)).ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error("snild did not come back");
    await sleep(250);
  }
}

/** Call the API from the test itself, as the snild page would (same Origin). */
export async function api(method, path, { body, token } = {}) {
  const headers = { origin: BASE };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.cookie = `snild_session=${token}`;
  const request = () => fetch(`${BASE}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  // Node keeps connections open between calls; one the server has just closed fails once: try again.
  const response = await request().catch(() => sleep(100).then(request));
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}

/** Make sure the people the tests use exist: alice (the first admin) and bob. */
export async function ensurePeople() {
  const status = await api("GET", "/auth/status");
  if (status.body.setup_required) {
    const code = /setup code (\S+)/.exec(admin("setup-code"))[1];
    const made = await api("POST", "/auth/setup", { body: { code, username: "alice", display_name: "Alice", password: PASSWORD } });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    givenPassword.add("alice");
  }
  await addPerson("alice"); // in case someone else set snild up
  await addPerson("bob");
}

/**
 * Add someone, or give them this file's password if they already exist (which signs them out everywhere).
 * Done once per person per file, and through snild-admin, so no failed sign-in counts against the limits.
 */
export async function addPerson(username) {
  if (givenPassword.has(username)) return;
  try {
    admin(`create-user ${username} --password-stdin`, `${PASSWORD}\n`);
  } catch (error) {
    if (!String(error.stderr).includes("taken")) throw error;
    admin(`enable-user ${username}`);
    admin(`reset-password ${username} --password-stdin`, `${PASSWORD}\n`);
  }
  givenPassword.add(username); // only once snild-admin has done it
}

/** A session token for this person, signed in through the API. */
export async function tokenFor(username, password = PASSWORD) {
  const response = await api("POST", "/auth/sign-in", { body: { username, password } });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return /snild_session=([^;]+)/.exec(response.headers.get("set-cookie"))[1];
}

/**
 * A page signed in as `username`, in its own browser context (its own cookies, like its own browser),
 * showing `path`. Pass `context` to open another tab in a context that already exists.
 */
export async function pageAs(browser, username, path = "/", { context = null, width, height } = {}) {
  const page = await browser.newPage({ context, width, height });
  if (!context) {
    await page.browser.send("Storage.setCookies", {
      browserContextId: page.context,
      cookies: [{ name: "snild_session", value: await tokenFor(username), url: `${BASE}/`, httpOnly: true, sameSite: "Lax" }],
    });
  }
  await page.goto(BASE + path);
  await page.waitFor(() => document.querySelector("#message"), { what: "the chat page" });
  return page;
}

/** Fill in the sign-in form and send it. */
export async function signInForm(page, username, password) {
  await page.waitFor(() => document.querySelector("#signin-username"), { what: "the sign-in form" });
  await page.eval(() => {
    document.querySelector("#signin-username").value = "";
    document.querySelector("#signin-password").value = "";
  });
  await page.focus("#signin-username");
  await page.type(username);
  await page.focus("#signin-password");
  await page.type(password);
  await page.press("Enter");
}

/** Type a message into the composer and send it with Enter. */
export async function say(page, message) {
  await page.focus("#message");
  await page.type(message);
  await page.press("Enter");
}

/** Wait until no reply is being written and the composer is free. */
export async function waitForIdle(page, timeout = 20_000) {
  await page.waitFor(() => !document.querySelector("[aria-busy=true]") && !document.querySelector(".send.is-stop"),
    { timeout, what: "the reply to finish" });
}

export async function openBrowser() {
  return Browser.launch();
}

/**
 * Fail if the page logged an error, threw, or broke its Content-Security-Policy; keep a screenshot of failures.
 * @param {import("./cdp.js").Page} page
 * @param {string} name
 */
export async function assertClean(page, name = "page") {
  if (page.problems.length && process.env.SNILD_SHOTS) await page.screenshot(join(process.env.SNILD_SHOTS, `${name}.png`));
  assert.deepEqual(page.problems, [], `${name} had problems`);
}

/** The assistant's last answer as plain text. */
export function lastAnswer(page) {
  return page.eval(() => [...document.querySelectorAll(".message-assistant")].at(-1)?.textContent ?? "");
}
