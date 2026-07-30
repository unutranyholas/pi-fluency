import { describe, expect, it } from "vitest";
import { formatStatus } from "../extensions/pi-fluency/status.js";

describe("formatStatus", () => {
  it("formats real unclamped analytics", () => {
    expect(formatStatus({
      kind: "progress",
      pendingOccurrences: 127,
      activeRules: 42,
      sparkline: "▆▄▃▂▁▂▂",
      ratePerThousand: 8.4,
    })).toBe("󰇮 127  󰌵 42  ▆▄▃▂▁▂▂ 8.4/k");
  });

  it("formats empty analytics", () => {
    expect(formatStatus({
      kind: "progress",
      pendingOccurrences: 0,
      activeRules: 0,
      sparkline: "·······",
      ratePerThousand: undefined,
    })).toBe("󰇰 0  󰌵 0  ······· —/k");
  });

  it.each(["auth", "model", "analyze", "store", "migrate"] as const)("formats %s errors", (reason) => {
    expect(formatStatus({ kind: "error", reason })).toBe(`󰅙 ERR ${reason}`);
  });

  it("normalizes malformed progress fields without clamping real counts", () => {
    expect(formatStatus({
      kind: "progress",
      pendingOccurrences: Number.POSITIVE_INFINITY,
      activeRules: -4,
      sparkline: "bad",
      ratePerThousand: Number.NaN,
    })).toBe("󰇰 0  󰌵 0  ······· —/k");
    expect(formatStatus({
      kind: "progress",
      pendingOccurrences: 12_345.9,
      activeRules: 678.8,
      sparkline: "▁▂▃▄▅▆▇",
      ratePerThousand: 12.349,
    })).toBe("󰇮 12345  󰌵 678  ▁▂▃▄▅▆▇ 12.3/k");
  });

  it.each([
    [{ kind: "initial-loading" } as const, "󰇰 …  󰌵 …  ······· —/k"],
    [{ kind: "hidden" } as const, undefined],
  ])("formats lifecycle state %#", (input, expected) => {
    expect(formatStatus(input)).toBe(expected);
  });
});
