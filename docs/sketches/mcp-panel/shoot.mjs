// Screenshots of the MCP panel sketch: WebKit, 1440×900 @2x, dark and light per variant.
// node shoot.mjs [a,b,c]   (imports Playwright from gui/frontend/node_modules)
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../../../gui/frontend/package.json"));
const { webkit } = require("@playwright/test");

const variants = (process.argv[2] || "a,b,c").split(",");
const browser = await webkit.launch();
for (const v of variants) {
  for (const theme of ["dark", "light"]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    await page.goto(`file://${path.join(here, "index.html")}?variant=${v}&theme=${theme}`);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(here, "shots", `${v}-${theme}.png`) });
    const panel = page.locator(".panel");
    await panel.screenshot({ path: path.join(here, "shots", `${v}-${theme}-panel.png`) });
    await page.close();
  }
}
await browser.close();
console.log("done");
