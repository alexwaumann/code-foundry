// Screenshots of the actions sketch: WebKit, 1180 wide @2x (the thread-header sketch's width),
// dark and light per state. The header shot is the thread-header crop (1180x150); menus are
// cropped to 1180x400; dialogs and the bottom panel are the full 1180x760 window.
// node shoot.mjs [name,...]   (Playwright from gui/frontend/node_modules, or CF_FRONTEND=<dir>)
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const frontend = process.env.CF_FRONTEND || path.join(here, "../../../gui/frontend");
const require = createRequire(path.join(frontend, "package.json"));
const { webkit } = require("@playwright/test");

const W = 1180, H = 760;
const shots = {
  "header": { q: "v=header", h: 150 },
  "menu-a": { q: "v=menu&x=a", h: 400 },
  "menu-b": { q: "v=menu&x=b", h: 400 },
  "menu-empty": { q: "v=empty", h: 400 },
  "dialog-new": { q: "v=new" },
  "dialog-edit": { q: "v=edit" },
  "dialog-delete": { q: "v=delete" },
  "panel-running-a": { q: "v=running&x=a" },
  "panel-running-b": { q: "v=running&x=b" },
  "panel-exited-a": { q: "v=exited&x=a" },
  "panel-exited-b": { q: "v=exited&x=b" },
  "panel-exited-ok-a": { q: "v=exited&x=a&code=0" },
};
const only = process.argv[2] ? process.argv[2].split(",") : Object.keys(shots);
const browser = await webkit.launch();
for (const name of only) {
  const { q, h = H } = shots[name];
  for (const theme of ["dark", "light"]) {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
    await page.goto(`file://${path.join(here, "index.html")}?${q}&theme=${theme}`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(here, `${name}-${theme}.png`), clip: { x: 0, y: 0, width: W, height: h }, animations: "disabled" });
    await page.close();
  }
}
await browser.close();
console.log("done");
