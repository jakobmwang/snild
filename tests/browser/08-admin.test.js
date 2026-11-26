// The admin area: pages with their own addresses (People, Settings), reached from the account menu; a member
// cannot open them; the chat and its draft are waiting on the way back.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { BASE, PASSWORD, api, assertClean, ensurePeople, openBrowser, pageAs, say, signInForm, tokenFor, waitForIdle } from "./harness.js";

let browser;
before(async () => {
  await ensurePeople();
  browser = await openBrowser();
});
after(async () => {
  await api("PATCH", "/admin/settings", { body: { session_idle_days: 7, session_max_days: 30 }, token: await tokenFor("alice") });
  await browser?.close();
});

/** The account menu's entries, after opening it. */
async function accountMenu(page) {
  await page.click(".rail-account");
  await page.waitFor(() => !document.querySelector(".rail-bottom .menu").hidden, { what: "the account menu" });
  return page.eval(() => [...document.querySelectorAll(".rail-bottom .menu button")].map((b) => b.textContent));
}

async function chooseMenuItem(page, label) {
  await page.eval((wanted) => [...document.querySelectorAll(".rail-bottom .menu button")].find((b) => b.textContent === wanted).click(), label);
}

test("an admin reaches People from the account menu, and the chat and its draft wait on the way back", async () => {
  const page = await pageAs(browser, "alice");
  await page.focus("#message");
  await page.type("a draft for later");
  assert.ok((await accountMenu(page)).includes("Admin"));
  await chooseMenuItem(page, "Admin");
  await page.waitFor(() => location.pathname === "/admin/people" && document.querySelector(".person"), { what: "People" });
  assert.equal(await page.eval(() => document.querySelector(".tab[aria-current=page]").textContent), "People");
  await page.click(".tab[href='/admin/settings']");
  await page.waitFor(() => location.pathname === "/admin/settings" && document.querySelector("#setting-session_idle_days"),
    { what: "Settings" });
  await page.eval(() => history.back());
  await page.waitFor(() => location.pathname === "/admin/people", { what: "Back to People" });
  await page.reload();
  await page.waitFor(() => document.querySelector(".person"), { what: "People after a reload" });
  await page.click(".back");
  await page.waitFor(() => !location.pathname.startsWith("/admin") && document.querySelector("#message"), { what: "the chat" });
  assert.equal(await page.eval(() => document.querySelector("#message").value), "a draft for later");
  await assertClean(page, "admin routes");
  await page.close();
});

test("an admin adds someone, who signs in; a new password ends their session", async () => {
  const username = `dora-${randomBytes(3).toString("hex")}`;
  const admin = await pageAs(browser, "alice", "/admin/people");
  await admin.waitFor(() => document.querySelector(".person"), { what: "People" });
  await admin.click(".toolbar .button-primary");
  await admin.focus("#person-username");
  await admin.type(username);
  await admin.focus("#person-name");
  await admin.type("Dora");
  await admin.focus("#person-password");
  await admin.type(PASSWORD);
  await admin.press("Enter");
  await admin.waitFor((name) => document.querySelector(`.person[data-username="${name}"]`), { args: [username], what: "Dora's row" });
  assert.equal(await admin.eval(() => document.querySelector("#add-person").hidden), true, "the form closes");

  await admin.focus(".search");
  await admin.type("dora");
  await admin.waitFor(() => [...document.querySelectorAll(".person")].filter((p) => !p.hidden).length === 1, { what: "the search" });

  const dora = await browser.newPage();
  await dora.goto(`${BASE}/`);
  await signInForm(dora, username, PASSWORD);
  await dora.waitFor(() => document.querySelector("#message"), { what: "Dora's chat" });
  assert.ok(!(await accountMenu(dora)).includes("Admin"), "a member does not see Admin");
  await dora.goto("about:blank");
  await dora.goto(`${BASE}/admin/settings`);
  await dora.waitFor(() => location.pathname === "/" && /Only admins/.test(document.querySelector(".notices")?.textContent || ""),
    { what: "a member sent back to the chat" });

  await admin.click(`.person[data-username="${username}"] .icon-button`);
  await admin.eval((name) => [...document.querySelectorAll(`.person[data-username="${name}"] .menu button`)]
    .find((b) => b.textContent === "Set password").click(), username);
  await admin.waitFor(() => document.querySelector(".inline-form input"), { what: "the password form" });
  await admin.type(`${PASSWORD} again`);
  await admin.press("Enter");
  await admin.waitFor(() => !document.querySelector(".inline-form") && /new password/.test(document.querySelector(".toasts")?.textContent || ""),
    { what: "the password saved" });
  await dora.goto(`${BASE}/`);
  await dora.waitFor(() => document.querySelector("#signin-username"), { what: "Dora signed out" });
  dora.allow(/status of 401/);
  await assertClean(dora, "member");
  await assertClean(admin, "people");
  await admin.close();
  await dora.close();
});

test("settings: change, see the save bar, an error beside its field, then save", async () => {
  const page = await pageAs(browser, "alice", "/admin/settings");
  await page.waitFor(() => document.querySelector("#setting-session_idle_days"), { what: "Settings" });
  assert.equal(await page.eval(() => document.querySelector(".savebar").hidden), true);
  await page.eval(() => (document.querySelector("#setting-session_idle_days").value = ""));
  await page.focus("#setting-session_idle_days");
  await page.type("9999");
  await page.waitFor(() => !document.querySelector(".savebar").hidden, { what: "the save bar" });
  await page.click(".savebar .button-primary");
  await page.waitFor(() => !document.querySelector("#setting-session_idle_days-error").hidden, { what: "the field's error" });
  page.allow(/status of 422/);
  await page.eval(() => (document.querySelector("#setting-session_idle_days").value = ""));
  await page.focus("#setting-session_idle_days");
  await page.type("3");
  await page.click("#setting-session_max_days-none");
  await page.click(".savebar .button-primary");
  await page.waitFor(() => document.querySelector(".savebar").hidden && /saved/.test(document.querySelector(".toasts")?.textContent || ""),
    { what: "saved" });
  await page.reload();
  await page.waitFor(() => document.querySelector("#setting-session_idle_days")?.value === "3", { what: "the saved value" });
  assert.equal(await page.eval(() => document.querySelector("#setting-session_max_days-none").checked), true);
  await assertClean(page, "settings");
  await page.close();
});

test("a chat created while People is open keeps the admin address, and Back goes to that chat", async () => {
  const page = await pageAs(browser, "alice");
  await page.focus("#message");
  await page.type("[scenario:slow] going to admin");
  await page.press("Enter");
  await accountMenu(page);
  await chooseMenuItem(page, "Admin");
  await page.waitFor(() => location.pathname === "/admin/people", { what: "People" });
  await page.waitFor(() => document.querySelector(".rail-item"), { what: "the new chat in the list" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(await page.eval(() => location.pathname), "/admin/people", "the admin address stays");
  await page.click(".back");
  await page.waitFor(() => /^\/c\//.test(location.pathname) && document.querySelector(".message-user"),
    { what: "the chat that was created" });
  await page.press("Escape"); // stop the slow reply
  await assertClean(page, "created in admin");
  await page.close();
});

test("renaming a chat from the list works when the admin area was opened directly", async () => {
  const setup = await pageAs(browser, "alice");
  await say(setup, "[scenario:markdown] something to rename");
  await waitForIdle(setup);
  await setup.close();
  const page = await pageAs(browser, "alice", "/admin/people");
  await page.waitFor(() => document.querySelector(".person") && document.querySelector(".rail-item"), { what: "People and the list" });
  await page.click(".rail-item .rail-more");
  await page.eval(() => [...document.querySelectorAll(".rail-item .menu button")].find((b) => b.textContent === "Rename").click());
  await page.waitFor(() => document.querySelector(".rail-rename input"), { what: "the rename field" });
  await page.eval(() => (document.querySelector(".rail-rename input").value = ""));
  await page.type("Renamed from admin");
  await page.press("Enter");
  await page.waitFor(() => [...document.querySelectorAll(".rail-link")].some((a) => a.textContent === "Renamed from admin"),
    { what: "the new title in the list" });
  await assertClean(page, "rename in admin");
  await page.close();
});

test("deleting the open chat from the list while in Admin keeps the admin address; Back goes to a new chat", async () => {
  const page = await pageAs(browser, "alice");
  await say(page, "[scenario:markdown] to be deleted");
  await waitForIdle(page);
  await accountMenu(page);
  await chooseMenuItem(page, "Admin");
  await page.waitFor(() => location.pathname === "/admin/people", { what: "People" });
  await page.click(".rail-item.is-current .rail-more, .rail-item .rail-more");
  await page.eval(() => [...document.querySelectorAll(".rail-item .menu button")].find((b) => b.textContent === "Delete").click());
  await page.waitFor(() => document.querySelector("dialog[open] .button-danger"), { what: "the delete question" });
  await page.click("dialog[open] .button-danger");
  await page.waitFor(() => !document.querySelector("dialog[open]"), { what: "the dialog to close" });
  assert.equal(await page.eval(() => location.pathname), "/admin/people", "the admin address stays");
  await page.click(".back");
  await page.waitFor(() => location.pathname === "/" && document.querySelector(".starter"), { what: "a new chat" });
  await assertClean(page, "delete in admin");
  await page.close();
});
