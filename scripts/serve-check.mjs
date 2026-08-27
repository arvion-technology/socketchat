#!/usr/bin/env node
// Static checks for the demo bundle: assets exist, required wiring is present,
// no placeholder text leaked into the published page.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

const demoDir = process.argv[2] || "demo";
const errors = [];
const warn = [];

function must(cond, msg) { if (!cond) errors.push(msg); }

const indexPath = join(demoDir, "index.html");
must(existsSync(indexPath), `missing ${indexPath}`);
if (existsSync(indexPath)) {
  const html = readFileSync(indexPath, "utf8");
  must(/<title>[^<]{4,}<\/title>/.test(html), "demo/index.html needs a descriptive <title>");
  must(/arvion\.css/.test(html), "demo/index.html must load arvion.css");
  must(/arvion\.js/.test(html), "demo/index.html must load arvion.js");
  must(/demo-banner/.test(html), "demo/index.html must include the demo banner (link back to the gallery)");
  must(!/\{\{|TODO:|Lorem ipsum/i.test(html), "demo/index.html contains placeholder text");
  // every local href/src must exist
  const refs = [...html.matchAll(/(?:href|src)="([^"#?]+)"/g)].map((m) => m[1])
    .filter((r) => !/^(https?:|mailto:|data:|\/\/)/.test(r));
  for (const ref of refs) {
    const target = ref.startsWith("/") ? join(demoDir, ref) : join(demoDir, ref);
    if (!existsSync(target)) errors.push(`broken local reference: ${ref}`);
  }
}
for (const asset of ["arvion.css", "arvion.js", "app.js"]) {
  must(existsSync(join(demoDir, asset)), `demo/${asset} is missing`);
}
const css = existsSync(join(demoDir, "arvion.css")) ? readFileSync(join(demoDir, "arvion.css"), "utf8") : "";
must(/--gold:\s*#f5c26b/i.test(css), "demo/arvion.css is not the Arvion brand stylesheet");
if (existsSync(join(demoDir, "fonts"))) {
  const fonts = ["Inter-400_700.woff2", "Poppins-600.woff2"];
  for (const f of fonts) must(existsSync(join(demoDir, "fonts", f)), `missing font ${f}`);
} else warn.push("demo/fonts missing — screenshots will fall back to system fonts");
must(existsSync("docs/screenshot.png"), "docs/screenshot.png is missing (run npm run shot)");

if (warn.length) console.warn("warnings:\n - " + warn.join("\n - "));
if (errors.length) { console.error("demo check failed:\n - " + errors.join("\n - ")); process.exit(1); }
console.log("demo check passed");
