// Screenshots of the agents panel sketch: WebKit, 1440×900 @2x, dark and light.
// node shoot.mjs   renders panel variants a,b,c (thread=chip) and thread options strip,line (variant b).
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../../../gui/frontend/package.json"));
const { webkit } = require("@playwright/test");

const combos = (process.argv[2] ? process.argv[2].split(",").map((s) => s.split(":")) : [["l1", "strip"], ["l2", "strip"]]);
const browser = await webkit.launch();
for (const [v, t] of combos) {
  for (const theme of ["dark", "light"]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    await page.goto(`file://${path.join(here, "index.html")}?variant=${v}&thread=${t}&theme=${theme}`);
    await page.waitForTimeout(300);
    const name = `${v}-${t}-${theme}`;
    await page.screenshot({ path: path.join(here, "shots", `${name}.png`) });
    await page.locator(".panel").screenshot({ path: path.join(here, "shots", `${name}-panel.png`) });
    await page.close();
  }
}
await browser.close();
console.log("done");
