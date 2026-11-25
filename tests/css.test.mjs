import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Guards the rule's presence only; the cascade itself needs a browser.
const css = readFileSync(new URL("../public/css/app.css", import.meta.url), "utf8");

test("the stylesheet hides every element with the hidden attribute", () => {
  assert.ok(/(^|[\s}])\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/m.test(css), "no [hidden] { display: none !important; } rule");
});

test("the stylesheet has no special case for the search clear button", () => {
  assert.ok(!css.includes(".search-clear[hidden]"), "a .search-clear[hidden] rule remains");
});
