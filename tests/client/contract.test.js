import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { browserTools } from "../../web/js/runtime/tools.js";

test("the browser runs exactly the tools the server offers", () => {
  const contract = JSON.parse(readFileSync(new URL("../../snild/tools.json", import.meta.url), "utf8"));
  const enabled = contract.tools.filter((t) => t.enabled).map((t) => t.name).sort();
  assert.deepEqual([...browserTools({ assets: "/assets/x", resultChars: 50_000 }).tools.keys()].sort(), enabled);
});
