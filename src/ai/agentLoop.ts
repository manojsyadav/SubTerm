import type { ChatMsg, ToolCall, ToolDef } from "./providers";
export interface Part {
  text: string;
  /** Set for a fenced code block; the language tag is dropped. */
  code?: string;
}

/** Split model output into prose and fenced code blocks. An unclosed fence (mid-stream) stays prose. */
export function splitFences(src: string): Part[] {
  const parts: Part[] = [];
  const re = /```[^\n`]*\n([\s\S]*?)```/g;
  let last = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const before = src.slice(last, m.index).trim();
    if (before) parts.push({ text: before });
    const code = m[1].replace(/\n$/, "");
    if (code.trim()) parts.push({ text: "", code });
    last = re.lastIndex;
  }
  const rest = src.slice(last).trim();
  if (rest) parts.push({ text: rest });
  return parts;
}

export type Mode = "suggest" | "ask" | "auto";

export const TOOLS: ToolDef[] = [
  {
    name: "run_command",
    description:
      "Run one shell command on the user's current session and get back its stdout, stderr and exit code. The user sees and may decline every command. Non-interactive only: no editors, pagers or prompts; add flags like --no-pager or -y where needed.",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "The command line to run" } },
      required: ["command"],
    },
  },
  {
    name: "read_terminal",
    description: "Read the last lines of the user's visible terminal, to see what they ran and what it printed.",
    parameters: {
      type: "object",
      properties: { lines: { type: "integer", description: "How many lines, up to 200" } },
      required: ["lines"],
    },
  },
];

// Commands Auto mode may run without asking. A value lists the only allowed
// subcommands; `true` allows the command with any arguments.
const READ_ONLY: Record<string, true | string[]> = {
  ls: true, cat: true, head: true, tail: true, grep: true, egrep: true, wc: true, sort: true, uniq: true,
  cut: true, stat: true, file: true, df: true, du: true, free: true, uptime: true, ps: true, pwd: true,
  whoami: true, id: true, hostname: true, uname: true, date: true, which: true, lsblk: true, lscpu: true,
  nproc: true, ss: true, netstat: true, dmesg: true, journalctl: true, getent: true, findmnt: true,
  "Get-ChildItem": true, "Get-Content": true, "Get-Process": true, "Get-Service": true,
  systemctl: ["status", "is-active", "is-enabled", "is-failed", "list-units", "list-unit-files", "show", "cat"],
  docker: ["ps", "images", "logs", "inspect", "stats", "version", "info", "top", "port"],
  kubectl: ["get", "describe", "logs", "top", "version"],
  git: ["status", "log", "diff", "show", "branch", "remote"],
  ip: ["a", "addr", "address", "r", "route", "l", "link", "neigh"],
};

// Output redirection, substitution, backgrounding, privilege, and following a log forever.
const UNSAFE = /[>`]|\$\(|(^|[^&])&($|[^&])|\s(-f|--follow)\b|\b(sudo|su|doas)\b/;
// Reading these would send a secret to the model, so Auto asks first.
const SECRET_PATH = /\.ssh\/|id_(rsa|ecdsa|ed25519)|shadow|\.env\b|\.pem\b|\.key\b|credential|secret|token|passw/i;

/** True when every command in a pipeline or `&&` / `;` chain only reads. */
export function isReadOnly(command: string): boolean {
  const cmd = command.trim();
  if (!cmd || UNSAFE.test(cmd) || SECRET_PATH.test(cmd) || /\n/.test(cmd)) return false;
  return cmd.split(/\|\||&&|\||;/).every((segment) => {
    const [name, sub] = segment.trim().split(/\s+/);
    const rule = READ_ONLY[name];
    if (rule === true) return true;
    if (!rule) return false;
    if (name === "ip" && /\b(add|del|delete|set|flush|change|replace)\b/.test(segment)) return false;
    if (name === "docker" && sub === "stats" && !/--no-stream/.test(segment)) return false;
    return !!sub && rule.includes(sub);
  });
}

export interface AgentIO {
  chat: (messages: ChatMsg[]) => Promise<ChatMsg>;
  /** Resolve true to run. Called for every run_command, whatever the mode. */
  approve: (command: string) => Promise<boolean>;
  runCommand: (command: string) => Promise<string>;
  readTerminal: (lines: number) => string;
  onUpdate: (messages: ChatMsg[]) => void;
}

export type AgentEnd = "done" | "declined" | "step-limit";

/**
 * Chat until the model stops calling tools. A declined command ends the loop
 * so the user can say what to do instead; every call still gets a result,
 * because both APIs reject a tool call left unanswered.
 */
export async function runAgent(start: ChatMsg[], io: AgentIO, maxSteps = 10): Promise<AgentEnd> {
  const msgs = [...start];
  for (let step = 0; step < maxSteps; step++) {
    const reply = await io.chat(msgs);
    msgs.push(reply);
    io.onUpdate([...msgs]);
    const calls = reply.toolCalls ?? [];
    if (calls.length === 0) return "done";
    let declined = false;
    for (const call of calls) {
      const content = declined ? "Skipped: the user declined an earlier command." : await runTool(call, io);
      if (content === DECLINED) declined = true;
      msgs.push({ role: "tool", toolCallId: call.id, content });
      io.onUpdate([...msgs]);
    }
    if (declined) return "declined";
  }
  return "step-limit";
}

const DECLINED = "The user declined to run this command.";

async function runTool(call: ToolCall, io: AgentIO): Promise<string> {
  let args: Record<string, unknown>;
  try {
    args = call.arguments.trim() ? JSON.parse(call.arguments) : {};
  } catch {
    return `Error: arguments were not valid JSON: ${call.arguments}`;
  }
  if (call.name === "read_terminal") {
    const n = Math.min(Math.max(Number(args.lines) || 50, 1), 200);
    return io.readTerminal(n) || "(the terminal is empty)";
  }
  if (call.name === "run_command") {
    const command = typeof args.command === "string" ? args.command.trim() : "";
    if (!command) return "Error: no command given.";
    if (!(await io.approve(command))) return DECLINED;
    try {
      return await io.runCommand(command);
    } catch (e) {
      return `Error: ${e}`;
    }
  }
  return `Error: unknown tool ${call.name}.`;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
  timedOut: boolean;
}

export function formatExec(r: ExecResult, timeoutSecs: number): string {
  const parts = [r.timedOut ? `Timed out after ${timeoutSecs} s and was stopped.` : `Exit code: ${r.exitCode ?? "unknown"}`];
  if (r.truncated) parts.push("(Output cut to its last 16 KB.)");
  if (r.stdout.trim()) parts.push(`stdout:\n${r.stdout.trimEnd()}`);
  if (r.stderr.trim()) parts.push(`stderr:\n${r.stderr.trimEnd()}`);
  if (!r.stdout.trim() && !r.stderr.trim()) parts.push("(no output)");
  return parts.join("\n");
}
