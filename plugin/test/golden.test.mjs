import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { getAgyChildrenRegistry } from "../src/driver/agy-children.ts";
import { capture } from "./golden/capture.mjs";

const baseline = JSON.parse(fs.readFileSync(new URL("./golden/baseline.json", import.meta.url), "utf8"));

function firstDifference(expected, actual, at = "$") {
  if (Object.is(expected, actual)) return undefined;
  if (typeof expected === "string" && typeof actual === "string") {
    const paths = value => value.replace(/<(?:TMP|HOME)>[^\s"'`<>)]*/g, part => part.replace(/\\+/g, "/"));
    if (paths(expected) === paths(actual)) return undefined;
  }
  if (typeof expected !== "object" || typeof actual !== "object" || expected === null || actual === null) {
    return `${at}: expected ${JSON.stringify(expected)?.slice(0, 300)} got ${JSON.stringify(actual)?.slice(0, 300)}`;
  }
  for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    const found = firstDifference(expected[key], actual[key], `${at}.${key}`);
    if (found) return found;
  }
  return undefined;
}

test("model inputs and native/Pi activities match the approved baseline", async (t) => {
  const events = ["exit", "SIGHUP"];
  const before = new Map(events.map((event) => [event, new Set(process.listeners(event))]));
  const registry = getAgyChildrenRegistry();
  const markers = { hooksInstalled: registry.hooksInstalled, ownedHooksInstalled: registry.ownedHooksInstalled };
  t.after(() => {
    // The registration capture loads the real extension, including its death hooks.
    for (const event of events) {
      for (const listener of process.listeners(event)) {
        if (!before.get(event).has(listener)) {
          process.removeListener(event, listener);
        }
      }
    }
    Object.assign(registry, markers);
  });
  const actual = await capture();
  const difference = firstDifference(baseline, actual);
  assert.equal(difference, undefined, difference);
});
