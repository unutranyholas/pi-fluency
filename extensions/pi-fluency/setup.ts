import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalLabel } from "./sanitize.js";
import type { FluencyStore } from "./store.js";

export async function runSetup(
  ctx: ExtensionCommandContext,
  store: FluencyStore,
  options: { enable?: boolean; now?: () => number } = {},
): Promise<boolean> {
  const models = ctx.modelRegistry.getAvailable();
  const labels = models.map((model) =>
    `${sanitizeTerminalLabel(model.provider, 100) || "unknown-provider"}/${sanitizeTerminalLabel(model.id, 100) || "unknown-model"}`);
  const selected = await ctx.ui.select("Pi Fluency analyzer model", labels);
  if (!selected) return false;
  const model = models[labels.indexOf(selected)];
  if (!model) return false;
  const approved = await ctx.ui.confirm(
    "Enable Pi Fluency?",
    `User-authored prose will be sent to ${sanitizeTerminalLabel(model.provider, 100) || "unknown-provider"}/${sanitizeTerminalLabel(model.id, 100) || "unknown-model"} for background analytics after Pi Fluency allows a prompt. Code, commands, assistant text, and tool output are excluded. Raw prompt bodies are not stored; bounded sanitized excerpts may equal a short prompt. Optional preflight practice is off and requires a separate disclosure before first activation.`,
  );
  if (!approved) return false;
  await store.updateSettings({
    ...(options.enable === false ? {} : { enabled: true }),
    consentedAt: (options.now ?? Date.now)(),
    provider: model.provider,
    modelId: model.id,
  });
  return true;
}
