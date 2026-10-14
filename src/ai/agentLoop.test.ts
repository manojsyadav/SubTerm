import { describe, expect, it, vi } from "vitest";
import { formatExec, isReadOnly, runAgent, splitFences, type AgentIO } from "./agentLoop";
import type { ChatMsg } from "./providers";

describe("splitFences", () => {
  it("separates prose and commands", () => {
    expect(splitFences("Check disk:\n```bash\ndf -h\n```\nThen look for big files.")).toEqual([
      { text: "Check disk:" },
      { text: "", code: "df -h" },
      { text: "Then look for big files." },
    ]);
  });

  it("keeps an unfinished fence as prose while streaming", () => {
    expect(splitFences("Run:\n```sh\ndf")).toEqual([{ text: "Run:\n```sh\ndf" }]);
  });
});

describe("isReadOnly", () => {
  it.each([
    "df -h",
    "ps aux | grep -i nginx | head -n 5",
    "systemctl status nginx",
    "docker ps -a",
    "journalctl -u nginx -n 100 --no-pager",
    "ip addr",
    "uptime && free -m",
  ])("allows %s", (cmd) => expect(isReadOnly(cmd)).toBe(true));

  it.each([
    "rm -rf /tmp/x",
    "systemctl restart nginx",
    "docker rm web",
    "sudo cat /etc/hosts",
    "ls > out.txt",
    "cat $(echo /etc/hosts)",
    "tail -f /var/log/syslog",
    "ip route add 10.0.0.0/8 via 1.1.1.1",
    "docker stats",
    "sleep 100 &",
    "cat ~/.ssh/id_ed25519",
    "cat .env",
    "ls\nrm x",
    "",
  ])("asks for %s", (cmd) => expect(isReadOnly(cmd)).toBe(false));
});

const call = (id: string, command: string): ChatMsg => ({
  role: "assistant",
  content: "",
  toolCalls: [{ id, name: "run_command", arguments: JSON.stringify({ command }) }],
});

function io(replies: ChatMsg[], approve = true): AgentIO & { seen: ChatMsg[][] } {
  const seen: ChatMsg[][] = [];
  return {
    seen,
    chat: vi.fn(async (m: ChatMsg[]) => { seen.push([...m]); return replies.shift() ?? ({ role: "assistant", content: "done" } as ChatMsg); }),
    approve: vi.fn(async () => approve),
    runCommand: vi.fn(async (c: string) => `ran ${c}`),
    readTerminal: () => "",
    onUpdate: () => {},
  };
}

describe("runAgent", () => {
  it("feeds command output back until the model answers", async () => {
    const x = io([call("a", "df -h"), { role: "assistant", content: "Disk is fine." }]);
    expect(await runAgent([{ role: "user", content: "disk?" }], x)).toBe("done");
    expect(x.runCommand).toHaveBeenCalledWith("df -h");
    expect(x.seen[1].at(-1)).toEqual({ role: "tool", toolCallId: "a", content: "ran df -h" });
  });

  it("stops on a declined command and still answers every call", async () => {
    const reply: ChatMsg = {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "a", name: "run_command", arguments: '{"command":"rm -rf /tmp/x"}' },
        { id: "b", name: "run_command", arguments: '{"command":"ls"}' },
      ],
    };
    const x = io([reply], false);
    const updates: ChatMsg[][] = [];
    x.onUpdate = (m) => updates.push(m);
    expect(await runAgent([{ role: "user", content: "clean" }], x)).toBe("declined");
    expect(x.runCommand).not.toHaveBeenCalled();
    expect(x.chat).toHaveBeenCalledTimes(1);
    expect(updates.at(-1)!.filter((m) => m.role === "tool").map((m) => m.toolCallId)).toEqual(["a", "b"]);
  });

  it("ends when the user presses Stop between steps", async () => {
    let stop = false;
    const x = io([call("a", "uptime"), call("b", "uptime")]);
    x.runCommand = vi.fn(async () => { stop = true; return "ran"; });
    x.stopped = () => stop;
    expect(await runAgent([{ role: "user", content: "go" }], x)).toBe("stopped");
    expect(x.chat).toHaveBeenCalledTimes(1);
  });

  it("stops at the step limit", async () => {
    const x = io(Array.from({ length: 5 }, (_, i) => call(String(i), "uptime")));
    expect(await runAgent([{ role: "user", content: "loop" }], x, 3)).toBe("step-limit");
    expect(x.chat).toHaveBeenCalledTimes(3);
  });

  it("reports bad tool arguments to the model instead of throwing", async () => {
    const x = io([{ role: "assistant", content: "", toolCalls: [{ id: "a", name: "run_command", arguments: "{oops" }] }]);
    await runAgent([{ role: "user", content: "go" }], x);
    expect(x.seen[1].at(-1)!.content).toMatch(/not valid JSON/);
  });
});

it("formatExec reports a timeout and missing output", () => {
  expect(formatExec({ stdout: "", stderr: "", exitCode: null, truncated: false, timedOut: true }, 60)).toBe(
    "Timed out after 60 s and was stopped.\n(no output)",
  );
});
