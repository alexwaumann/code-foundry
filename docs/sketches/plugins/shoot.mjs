// Screenshots of the plugin surfaces sketch: WebKit, 1440x900 @2x.
// node shoot.mjs [jenkins,auth,list]
//   shots/<plugin>-<state>-<theme>.png        full page, dark and light
//   shots/<plugin>-<state>-<theme>-panel.png  the panel
//   shots/<plugin>-<state>-narrow.png         the panel at 280px (PANEL_MIN), dark, grown to its content
//   shots/<plugin>-<state>-outline.png        the panel with every node labelled by primitive (dark)
// plugin=list has no states: shots/list-<theme>.png, list-<theme>-panel.png, list-narrow.png.
// Playwright comes from gui/frontend/node_modules (this worktree's, else the main checkout's).
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const local = path.join(here, "../../../gui/frontend/package.json");
const pkg = fs.existsSync(path.join(here, "../../../gui/frontend/node_modules/@playwright")) ? local : (process.env.CF_FRONTEND_PKG || "/Users/alex/projects/code-foundry/gui/frontend/package.json");
const { webkit } = createRequire(pkg)("@playwright/test");

// The state names come from the data files themselves.
const ctx = {}; ctx.window = ctx;
vm.createContext(ctx);
for (const f of ["jenkins.js", "auth.js"]) vm.runInContext(fs.readFileSync(path.join(here, f), "utf8"), ctx);
const states = { jenkins: Object.keys(ctx.window.PLUGINS.jenkins.states), auth: Object.keys(ctx.window.PLUGINS.auth.states), list: [null] };

const which = (process.argv[2] || "jenkins,auth,list").split(",");
fs.mkdirSync(path.join(here, "shots"), { recursive: true });
const browser = await webkit.launch();
const shot = async (query, file, { panelOnly = false, tall = false } = {}) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await page.goto(`file://${path.join(here, "index.html")}?${query}${tall ? "&tall" : ""}`);
  await page.waitForTimeout(250);
  const out = path.join(here, "shots", file);
  if (panelOnly) await page.locator(".panel").screenshot({ path: out, animations: "disabled" });
  else await page.screenshot({ path: out, animations: "disabled" });
  await page.close();
};
for (const plugin of which) {
  for (const state of states[plugin]) {
    const base = state ? `${plugin}-${state}` : plugin;
    const q = `plugin=${plugin}${state ? `&state=${state}` : ""}`;
    for (const theme of ["dark", "light"]) {
      await shot(`${q}&theme=${theme}`, `${base}-${theme}.png`);
      await shot(`${q}&theme=${theme}`, `${base}-${theme}-panel.png`, { panelOnly: true });
    }
    await shot(`${q}&theme=dark&w=280`, `${base}-narrow.png`, { panelOnly: true, tall: true });
    if (state) await shot(`${q}&theme=dark&outline`, `${base}-outline.png`, { panelOnly: true, tall: true });
    console.log(base);
  }
}
await browser.close();
