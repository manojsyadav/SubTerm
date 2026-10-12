import { describe, it, expect } from "vitest";
import { overwritePolicyChoice } from "./confirm";

describe("overwritePolicyChoice", () => {
  it("answers without a dialog for skip and overwrite", () => {
    expect(overwritePolicyChoice("skip")).toBe("skip");
    expect(overwritePolicyChoice("overwrite")).toBe("overwrite");
  });

  it("asks (null) for the default, an empty value or anything unknown", () => {
    for (const v of ["ask", "", null, "bogus"]) expect(overwritePolicyChoice(v)).toBeNull();
  });
});
