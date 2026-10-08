/** ANSI content generators for the mock terminals. */

export const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const INV = "\x1b[7m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";
const CYAN = "\x1b[36m";
const GRAY = "\x1b[90m";
const ORANGE = "\x1b[38;5;209m";

export function prompt(cwd: string): string {
  const short = cwd.replace(/^\/Users\/[^/]+/, "~");
  return `${BOLD}${BLUE}${short}${RESET} ${GRAY}on${RESET} ${MAGENTA} main${RESET}\r\n${GREEN}❯${RESET} `;
}

function box(lines: string[], width: number): string {
  const inner = Math.max(20, Math.min(width - 4, 64));
  const top = `${ORANGE}╭${"─".repeat(inner + 2)}╮${RESET}`;
  const bottom = `${ORANGE}╰${"─".repeat(inner + 2)}╯${RESET}`;
  const body = lines.map((l) => {
    // eslint-disable-next-line no-control-regex
    const visible = l.replace(/\x1b\[[0-9;]*m/g, "");
    return `${ORANGE}│${RESET} ${l}${" ".repeat(Math.max(0, inner - Array.from(visible).length))} ${ORANGE}│${RESET}`;
  });
  return [top, ...body, bottom].join("\r\n");
}

export function claudeIntro(cwd: string, cols: number, task: string): string {
  return (
    box(
      [
        `${ORANGE}✻${RESET} ${BOLD}Welcome to Claude Code!${RESET}`,
        "",
        `  ${GRAY}/help for help, /status for your current setup${RESET}`,
        "",
        `  ${GRAY}cwd: ${cwd}${RESET}`,
      ],
      cols,
    ) +
    "\r\n\r\n" +
    `${GRAY}>${RESET} ${task}\r\n\r\n` +
    `${BOLD}⏺${RESET} I'll start by reading the current implementation.\r\n\r\n` +
    `${GREEN}⏺${RESET} ${BOLD}Read${RESET}(gui/frontend/src/components/sidebar/Sidebar.tsx)\r\n` +
    `  ${GRAY}⎿${RESET}  Read ${BOLD}182${RESET} lines\r\n\r\n` +
    `${GREEN}⏺${RESET} ${BOLD}Update${RESET}(gui/frontend/src/lib/tree.ts)\r\n` +
    `  ${GRAY}⎿${RESET}  Updated gui/frontend/src/lib/tree.ts with ${GREEN}24 additions${RESET} and ${RED}3 removals${RESET}\r\n\r\n`
  );
}

const claudeSteps = [
  `${GREEN}⏺${RESET} ${BOLD}Bash${RESET}(go test ./internal/store/...)\r\n  ${GRAY}⎿${RESET}  ${GREEN}ok${RESET}  github.com/awaumann/code-foundry/internal/store/terminal  0.412s\r\n\r\n`,
  `${GREEN}⏺${RESET} ${BOLD}Search${RESET}(pattern: "useVirtualizer", path: "gui/frontend/src")\r\n  ${GRAY}⎿${RESET}  Found ${BOLD}2${RESET} files\r\n\r\n`,
  `${BOLD}⏺${RESET} The tree now flattens into rows; only ${CYAN}visible${RESET} rows render.\r\n\r\n`,
  `${GREEN}⏺${RESET} ${BOLD}Update${RESET}(gui/frontend/src/components/sidebar/SidebarRow.tsx)\r\n  ${GRAY}⎿${RESET}  Updated with ${GREEN}9 additions${RESET} and ${RED}14 removals${RESET}\r\n\r\n`,
  `${YELLOW}⏺${RESET} ${BOLD}Bash${RESET}(pnpm run lint)\r\n  ${GRAY}⎿${RESET}  ${YELLOW}warning${RESET}  'rows' is assigned but never used\r\n\r\n`,
];

const spinner = ["✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳"];

/** One tick of a Claude-like session: rewrite the status line, sometimes append a step. */
export function claudeTick(n: number): string {
  const status = `\r\x1b[2K${ORANGE}${spinner[n % spinner.length] ?? "✻"}${RESET} ${ORANGE}Working…${RESET} ${GRAY}(${String(n)}s · esc to interrupt)${RESET}`;
  if (n % 3 !== 0) return status;
  const step = claudeSteps[Math.floor(n / 3) % claudeSteps.length] ?? "";
  return `\r\x1b[2K${step}${status}`;
}

const levels = [
  [`${GREEN}INFO ${RESET}`, "api: request method=/codefoundry.v1.HealthService/Ping status=200 dur=0.4ms"],
  [`${GREEN}INFO ${RESET}`, "terminal: attach id=t-claude subscribers=1"],
  [`${CYAN}DEBUG${RESET}`, "bus: publish type=terminal.Updated drops=0"],
  [`${YELLOW}WARN ${RESET}`, "repo: fsnotify overflow, scheduling full reconcile root=/Users/dev/src"],
  [`${GREEN}INFO ${RESET}`, "repo: reconcile done repos=3 worktrees=5 dur=38ms"],
  [`${RED}ERROR${RESET}`, "gh: graphql rate limited, backing off for=30s"],
] as const;

export function logLine(n: number, now = new Date()): string {
  const [lvl, msg] = levels[n % levels.length] ?? levels[0];
  return `${GRAY}${now.toISOString()}${RESET} ${lvl} ${msg}\r\n`;
}

export function testRunOutput(cwd: string): string {
  return (
    prompt(cwd) +
    "go test ./...\r\n" +
    `${GREEN}ok${RESET}  \tgithub.com/awaumann/code-foundry/internal/bus\t0.212s\r\n` +
    `${GREEN}ok${RESET}  \tgithub.com/awaumann/code-foundry/internal/paths\t0.104s\r\n` +
    `--- ${RED}FAIL${RESET}: TestResizeAppliesToPTY (0.00s)\r\n` +
    `    actor_test.go:88: got ${BOLD}80x24${RESET}, want ${BOLD}120x40${RESET}\r\n` +
    `${RED}FAIL${RESET}\r\n` +
    `${RED}FAIL${RESET}\tgithub.com/awaumann/code-foundry/internal/store/terminal\t0.341s\r\n` +
    `${RED}FAIL${RESET}\r\n`
  );
}

const procs = ["claude", "code-foundry", "node", "WebKit.WebContent", "gopls", "zsh", "git", "Ghostty", "kernel_task", "launchd", "mds_stores", "WindowServer"];

/** A full top-like frame for the alternate screen, drawn with absolute cursor moves. */
export function topFrame(n: number, cols: number, rows: number, now = new Date()): string {
  const pad = (s: string, w: number) => (s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length));
  const lines: string[] = [];
  lines.push(`${INV}${BOLD}${pad(` top - ${now.toTimeString().slice(0, 8)} up 3 days, 4:12,  load average: ${(1 + (n % 7) / 10).toFixed(2)} 1.10 0.98`, cols)}${RESET}`);
  lines.push(`Tasks: ${BOLD}412${RESET} total, ${GREEN}${String(2 + (n % 3))}${RESET} running, 410 sleeping`);
  lines.push(`%Cpu(s): ${BOLD}${(10 + ((n * 7) % 30)).toFixed(1)}${RESET} us, 4.1 sy, 0.0 ni, ${(80 - ((n * 7) % 30)).toFixed(1)} id`);
  lines.push(`MiB Mem: ${BOLD}36864.0${RESET} total, ${GREEN}8123.4${RESET} free, 20110.2 used`);
  lines.push("");
  lines.push(`${INV}${pad("    PID USER       %CPU  %MEM     TIME+ COMMAND", cols)}${RESET}`);
  const body = Math.max(0, rows - lines.length - 1);
  for (let i = 0; i < body; i++) {
    const cpu = (((i * 37 + n * 13) % 97) / (i + 1)) * 1.7;
    const color = cpu > 40 ? RED : cpu > 15 ? YELLOW : GREEN;
    const pid = String(1000 + i * 73).padStart(7);
    lines.push(`${pid} dev       ${color}${cpu.toFixed(1).padStart(5)}${RESET} ${((i * 3.3) % 12).toFixed(1).padStart(5)}  ${String(i).padStart(3)}:${String((n + i) % 60).padStart(2, "0")}.00 ${procs[i % procs.length] ?? ""}`);
  }
  lines.push(`${INV}${pad(" q Quit   h Help   ↑↓ Select   F6 Sort", cols)}${RESET}`);
  return "\x1b[?25l" + lines.map((l, i) => `\x1b[${String(i + 1)};1H${l}\x1b[K`).join("");
}

export const ENTER_ALT = "\x1b[?1049h\x1b[H\x1b[2J";
