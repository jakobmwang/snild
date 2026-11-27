// The first visit: create the first admin with the setup code from the log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE, PASSWORD, api, assertClean, loggedSetupCode, openBrowser } from "./harness.js";

test("the setup code creates the first admin, then never works again", async (t) => {
  if (!(await api("GET", "/auth/status")).body.setup_required) {
    assert.notEqual(process.env.SNILD_EXPECT_SETUP, "1", "snild is already set up, but this instance should be fresh");
    t.skip("snild is already set up (run against a fresh server to test setup)");
    return;
  }
  const code = loggedSetupCode();
  assert.ok(code, "snild's log names a setup code");
  const browser = await openBrowser();
  try {
    // With public_url set, the log's link carries the code: it fills the form and leaves the address bar.
    const linked = await browser.newPage();
    await linked.goto(`${BASE}/#setup=${code}`);
    await linked.waitFor(() => document.querySelector("#setup-username"));
    assert.ok(await linked.eval(() => location.hash === ""), "the code is wiped from the address bar");
    // Compared without printing either value: a failed run's output is public.
    assert.ok((await linked.eval(() => document.querySelector("#setup-code").value)) === code, "the link fills in the code");
    await assertClean(linked, "setup link");
    await linked.close();

    // Without it, the log gives the code alone: it is pasted into the form.
    const page = await browser.newPage();
    await page.goto(`${BASE}/`);
    await page.waitFor(() => document.querySelector("#setup-code"));
    assert.equal(await page.eval(() => document.querySelector("#setup-code").value), "");
    await page.focus("#setup-code");
    await page.type(code);

    // a mismatched repeat is caught before anything is sent
    await page.focus("#setup-username");
    await page.type("alice");
    await page.focus("#setup-name");
    await page.type("Alice");
    await page.focus("#setup-password");
    await page.type(PASSWORD);
    await page.focus("#setup-repeat");
    await page.type("something else entirely");
    await page.press("Enter");
    await page.waitFor(() => document.querySelector(".form-error:not([hidden])"));
    assert.equal(await page.eval(() => document.activeElement.id), "setup-repeat");

    await page.eval(() => (document.querySelector("#setup-repeat").value = ""));
    await page.focus("#setup-repeat");
    await page.type(PASSWORD);
    await page.press("Enter");
    await page.waitFor(() => document.querySelector("#message"), { what: "the chat page" });
    assert.match(await page.text(".rail-account-name"), /Alice/);
    await assertClean(page, "setup");

    const again = await api("POST", "/auth/setup", { body: { code, username: "mallory", password: PASSWORD } });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, "setup_done");
  } finally {
    await browser.close();
  }
});
