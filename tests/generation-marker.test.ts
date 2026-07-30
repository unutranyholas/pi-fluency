import { describe, expect, it } from "vitest";
import {
  decodeHistoryGenerationMarker,
  encodeHistoryGenerationMarker,
} from "../extensions/pi-fluency/generation-marker.js";

const generation = "9a6d03ea-1a39-4760-8271-f7f5ab9ceae6";

describe("history generation marker codec", () => {
  it("decodes legacy plain UUID markers", () => {
    expect(decodeHistoryGenerationMarker(`  ${generation}\n`)).toEqual({
      generation,
      resetPending: false,
      legacy: true,
    });
  });

  it("round-trips canonical markers", () => {
    const encoded = encodeHistoryGenerationMarker({ generation, resetPending: true });
    expect(decodeHistoryGenerationMarker(encoded)).toEqual({
      generation,
      resetPending: true,
      legacy: false,
    });
  });

  it("encodes only canonical fields from structurally wider inputs", () => {
    const wider = { generation, resetPending: false, extra: "ignored" };
    const encoded = encodeHistoryGenerationMarker(wider);
    expect(JSON.parse(encoded)).toEqual({ generation, resetPending: false });
    expect(decodeHistoryGenerationMarker(encoded)).toEqual({
      generation,
      resetPending: false,
      legacy: false,
    });
  });

  it.each([
    "",
    "not-json",
    "null",
    "[]",
    "1",
    JSON.stringify({ generation: "not-a-uuid", resetPending: false }),
    JSON.stringify({ generation, resetPending: "false" }),
    JSON.stringify({ generation }),
    JSON.stringify({ generation, resetPending: false, extra: true }),
  ])("rejects malformed marker %#", (serialized) => {
    expect(() => decodeHistoryGenerationMarker(serialized)).toThrow("Invalid history generation");
  });
});
