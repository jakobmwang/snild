// Admin settings: change how long a sign-in lasts, "no limit" included, and see it kept.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { api, assertClean, ensurePeople, openBrowser, pageAs, tokenFor } from "./harness.js";

let browser;
before(async () => {
  await ensurePeople();
  browser = await openBrowser();
});
after(async () => {
  await api("PATCH", "/admin/settings", { body: { session_idle_days: 7, session_max_days: 30 }, token: await tokenFor("alice") });
  await browser?.close();
});

async function openSettings(page) {
  await page.click(".rail-account");
  await page.waitFor(() => [...document.querySelectorAll(".rail-bottom .menu button")].some((b) => b.textContent === "Settings"),
    { what: "Settings in the account menu" });
  await page.eval(() => [...document.querySelectorAll(".rail-bottom .menu button")].find((b) => b.textContent === "Settings").focus());
  await page.press("Enter");
  await page.waitFor(() => document.querySelector("dialog[open] #setting-session_idle_days"), { what: "the settings" });
}

test("an admin sets how long a sign-in lasts, no limit included", async () => {
  const page = await pageAs(browser, "alice");
  await openSettings(page);
  assert.equal(await page.eval(() => document.querySelector("#setting-session_idle_days").value), "7");
  await page.eval(() => (document.querySelector("#setting-session_idle_days").value = ""));
  await page.focus("#setting-session_idle_days");
  await page.type("3");
  await page.click("#setting-session_max_days-none");
  assert.equal(await page.eval(() => document.querySelector("#setting-session_max_days").disabled), true);
  await page.click("dialog[open] .form-actions button[type=submit]");
  await page.waitFor(() => !document.querySelector("dialog[open]"), { what: "the dialog to close" });

  await openSettings(page);
  assert.equal(await page.eval(() => document.querySelector("#setting-session_idle_days").value), "3");
  assert.equal(await page.eval(() => document.querySelector("#setting-session_max_days-none").checked), true);
  await page.press("Escape");
  await assertClean(page, "settings");
  await page.close();
});
