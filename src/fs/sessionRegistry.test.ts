import { describe, it, expect } from "vitest";
import { publishOpenSessions, getOpenSessions, remoteConnected } from "./sessionRegistry";

const s = (id: string, over: Partial<{ name: string; connected: boolean; isLocal: boolean }> = {}) =>
  ({ id, name: id, connected: true, isLocal: false, ...over });

describe("session registry", () => {
  it("keeps the same array when nothing changed and swaps it when something did", () => {
    publishOpenSessions([s("a"), s("b")]);
    const first = getOpenSessions();
    publishOpenSessions([s("a"), s("b")]);
    expect(getOpenSessions()).toBe(first);
    publishOpenSessions([s("a"), s("b", { connected: false })]);
    expect(getOpenSessions()).not.toBe(first);
  });

  it("offers only connected non-local sessions for copying", () => {
    const list = [s("a"), s("b", { connected: false }), s("c", { isLocal: true }), s("d")];
    expect(remoteConnected(list).map((x) => x.id)).toEqual(["a", "d"]);
  });
});
