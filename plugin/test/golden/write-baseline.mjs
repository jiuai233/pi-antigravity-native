// Run once on the pre-refactor code (1.0.30). The refactor must never rewrite this file.
import fs from "node:fs";
import { capture } from "./capture.mjs";

const target = new URL("./baseline.json", import.meta.url);
if (fs.existsSync(target) && !process.argv.includes("--force")) {
  console.error("baseline.json exists; refusing to overwrite (pass --force only on pre-refactor code).");
  process.exit(1);
}
fs.writeFileSync(target, `${JSON.stringify(await capture(), null, 2)}\n`, "utf8");
console.log("wrote", target.pathname);
process.exit(0);
