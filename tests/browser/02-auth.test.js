// Signing in and out, and what happens when a session ends under an open page.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { BASE, PASSWORD, addPerson, admin, api, assertClean, ensurePeople, openBrowser, pageAs, signInForm } from "./harness.js";

before(ensurePeople);

test("sign out, a wrong password, then the right one", async () => {
  const browser = await openBrowser();
  try {
    const page = await pageAs(browser, "alice");
    await page.click(".rail-account");
    await page.click(".rail-bottom .menu button:last-child");
    await signInForm(page, "alice", "not the password at all");
    await page.waitFor(() => document.querySelector(".form-error:not([hidden])")?.textContent.includes("do not match"));
    assert.equal(await page.eval(() => document.activeElement.id), "signin-password");
    page.allow(/status of 401/); // the refused sign-in, as the browser logs it
    await signInForm(page, "alice", PASSWORD);
    await page.waitFor(() => document.querySelector("#message"));
    await assertClean(page, "sign-in");
  } finally {
    await browser.close();
  }
});

test("too many wrong passwords: the form says how long to wait", async () => {
  await addPerson("victim");
  for (let i = 0; i < 10; i++) await api("POST", "/auth/sign-in", { body: { username: "victim", password: "wrong but long enough" } });
  const browser = await openBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(BASE);
    await signInForm(page, "victim", PASSWORD);
    await page.waitFor(() => /Too many attempts. Try again in/.test(document.querySelector(".form-error")?.textContent || ""));
    page.allow(/status of 429/);
    await assertClean(page, "throttle");
  } finally {
    await browser.close();
  }
});

test("a session ended elsewhere: sign in again and the draft is still there", async () => {
  await addPerson("carol");
  const browser = await openBrowser();
  try {
    const page = await pageAs(browser, "carol");
    await page.focus("#message");
    await page.type("a draft worth keeping");
    admin("disable-user carol"); // an admin, from the server's terminal
    await page.press("Enter");
    await page.waitFor(() => document.querySelector("#signin-username"), { what: "the sign-in form" });
    assert.match(await page.text(".auth-card"), /You were signed out/);
    admin("enable-user carol");
    await signInForm(page, "carol", PASSWORD);
    await page.waitFor(() => document.querySelector("#message")?.value === "a draft worth keeping", { what: "the draft" });
    page.allow(/status of 401/);
    await assertClean(page, "revoked");
  } finally {
    await browser.close();
  }
});
