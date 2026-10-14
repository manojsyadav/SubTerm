import { describe, expect, it } from "vitest";
import { windowsPtyFor } from "./windowsPty";

describe("windowsPtyFor", () => {
  it("keeps reflow on Windows 11 and turns it off when the build is unknown or older", () => {
    expect(windowsPtyFor("15.0.0")).toEqual({ backend: "conpty", buildNumber: 22000 });
    expect(windowsPtyFor("10.0.0")).toEqual({ backend: "conpty" });
    expect(windowsPtyFor(undefined)).toEqual({ backend: "conpty" });
  });
});
