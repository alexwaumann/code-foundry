/** ANSI content generators for the mock shells (prompt, top). */

export const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const INV = "\x1b[7m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";
const GRAY = "\x1b[90m";

export function prompt(cwd: string): string {
  const short = cwd.replace(/^\/Users\/[^/]+/, "~");
  return `${BOLD}${BLUE}${short}${RESET} ${GRAY}on${RESET} ${MAGENTA} main${RESET}\r\n${GREEN}❯${RESET} `;
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
