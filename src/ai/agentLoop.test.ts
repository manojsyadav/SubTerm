import { describe, expect, it } from "vitest";
import { splitFences } from "./agentLoop";

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
