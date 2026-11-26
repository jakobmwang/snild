// Admins manage people in the browser: add someone with a password, give them a new one; members do not see
// People.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { PASSWORD, assertClean, ensurePeople, openBrowser, pageAs, signInForm } from "./harness.js";

let browser;
before(async () => {
  await ensurePeople();
  browser = await openBrowser();
});
after(() => browser?.close());

/** The account menu's entries. */
async function accountMenu(page) {
  await page.click(".rail-account");
  await page.waitFor(() => !document.querySelector(".rail-bottom .menu").hidden, { what: "the account menu" });
  return page.eval(() => [...document.querySelectorAll(".rail-bottom .menu button")].map((b) => b.textContent));
}

/** Fill the open question dialog's fields in order, and confirm it. */
async function answer(page, ...values) {
  await page.waitFor(() => document.querySelector("dialog[open] dialog[open] .form-actions"), { what: "the dialog" });
  const ids = await page.eval(() => [...document.querySelectorAll("dialog[open] dialog[open] input:not([type=checkbox])")].map((i) => i.id));
  for (const [index, value] of values.entries()) {
    await page.focus(`#${ids[index]}`);
    await page.type(value);
  }
  await page.click("dialog[open] dialog[open] .form-actions button[type=submit]");
  await page.waitFor(() => !document.querySelector("dialog[open] dialog[open]"), { what: "the dialog to close" });
}

test("an admin adds someone, who signs in; a new password ends their session", async () => {
  const username = `dora-${randomBytes(3).toString("hex")}`;
  const admin = await pageAs(browser, "alice");
  assert.equal((await accountMenu(admin))[0], "People");
  await admin.click(".rail-bottom .menu button:first-child");
  await admin.waitFor(() => document.querySelector("dialog[open] .person"), { what: "the list of people" });
  await admin.click("dialog[open] .form-actions button:first-child"); // Add person
  await answer(admin, username, "Dora", PASSWORD);
  await admin.waitFor((name) => document.querySelector(`.person[data-username="${name}"]`), { args: [username], what: "Dora in the list" });
  await assertClean(admin, "added");

  const dora = await browser.newPage(); // a browser of her own
  await dora.goto((await admin.eval(() => location.origin)) + "/");
  await signInForm(dora, username, PASSWORD);
  await dora.waitFor(() => document.querySelector("#message"), { what: "the chat page" });
  assert.match(await dora.text(".rail-account-name"), /Dora/);
  assert.ok(!(await accountMenu(dora)).includes("People"), "a member does not see People");

  await admin.click(`.person[data-username="${username}"] .person-actions button:first-child`); // Set password
  await answer(admin, `${PASSWORD} again`);
  await dora.reload();
  await signInForm(dora, username, `${PASSWORD} again`);
  await dora.waitFor(() => document.querySelector("#message"), { what: "the chat page again" });
  dora.allow(/status of 401/);
  await assertClean(dora, "member");

  await admin.press("Escape");
  await admin.waitFor(() => !document.querySelector("dialog[open]"), { what: "People to close" });
  assert.equal(await admin.eval(() => document.activeElement?.matches(".rail-account")), true, "focus returns");
  await assertClean(admin, "people closed");
  await admin.close();
  await dora.close();
});
