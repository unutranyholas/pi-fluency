import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { runSetup } from "../extensions/pi-fluency/setup.js";
import type { FluencyStore } from "../extensions/pi-fluency/store.js";

describe("runSetup", () => {
  it("keeps provider and model terminal controls out of selection and consent UI", async () => {
    const model = { provider: "evil\u001b[31m-provider", id: "model\u009b32m-id" };
    const select = vi.fn(async (_title: string, options: string[]) => options[0]);
    const confirm = vi.fn(async (_title: string, _message: string) => true);
    const updateSettings = vi.fn(async () => undefined);
    const ctx = {
      modelRegistry: { getAvailable: () => [model] },
      ui: { select, confirm },
    } as unknown as ExtensionCommandContext;

    await runSetup(ctx, { updateSettings } as unknown as FluencyStore, { now: () => 123 });

    expect(select).toHaveBeenCalledWith("Pi Fluency analyzer model", ["evil-provider/model-id"]);
    const disclosure = confirm.mock.calls[0]?.[1];
    expect(disclosure).toContain("evil-provider/model-id");
    expect(disclosure).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      provider: model.provider,
      modelId: model.id,
    }));
  });
});
