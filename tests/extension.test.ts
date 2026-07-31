import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lock } from "proper-lockfile";
import { describe, expect, it, vi } from "vitest";
import { AnalyzerConfigurationError } from "../extensions/pi-fluency/analyzer.js";
import type { CoachingOverlay } from "../extensions/pi-fluency/coaching-overlay.js";
import { createFluencyExtension, type OpenInbox } from "../extensions/pi-fluency/index.js";
import { FluencyStore } from "../extensions/pi-fluency/store.js";
import { DEFAULT_SETTINGS, type AnalysisResult } from "../extensions/pi-fluency/types.js";
import {
  assistantMessage,
  createExtensionHarness,
  oneMistake,
  userMessage,
} from "./helpers/fakes.js";

const malformedAnalysisFixture = (value: unknown): AnalysisResult => value as AnalysisResult;

const collected = (promptHash: string, observedAt = 100) => ({
  promptHash,
  observedAt,
  prose: "I made an mistake.",
});

const EMPTY_STATUS = "󰇰 0  󰌵 0  ······· —/k";
const ZERO_RATE_STATUS = "󰇰 0  󰌵 0  ······▁ 0.0/k";
const PENDING_ONE_STATUS = "󰇮 1  󰌵 0  ······▁ 0.0/k";
const ACCEPTED_SINGLETON_STATUS = "󰇰 0  󰌵 0  ······▄ 250.0/k";

describe("Pi Fluency extension", () => {
  it("registers Powerbar segment after extension registration", async () => {
    const harness = await createExtensionHarness({ enabled: false });
    createFluencyExtension(harness.deps)(harness.pi);
    expect(harness.fakePi.eventEmissions).toContainEqual({
      channel: "powerbar:register-segment",
      data: { id: "pi-fluency", label: "Pi Fluency" },
    });
  });

  it("does not capture before consent", async () => {
    const harness = await createExtensionHarness({ enabled: false });
    createFluencyExtension(harness.deps)(harness.pi);

    await harness.emitInput("I made an mistake.");
    await harness.emitAgentSettled();
    expect(harness.analyzer.analyze).not.toHaveBeenCalled();
    expect(harness.statuses.get("pi-fluency")).toBeUndefined();
  });

  it("rejects enabled settings without valid consent and keeps status hidden", async () => {
    const harness = await createExtensionHarness({ enabled: false });
    await writeFile(join(harness.deps.rootDir, "settings.json"), JSON.stringify({
      ...DEFAULT_SETTINGS,
      enabled: true,
      provider: "google",
      modelId: "gemini-2.5-flash",
    }));
    createFluencyExtension(harness.deps)(harness.pi);

    await harness.emitInput("I made an mistake.");
    await harness.emitAgentSettled();
    expect(harness.analyzer.analyze).not.toHaveBeenCalled();
    expect(harness.statuses.get("pi-fluency")).toBeUndefined();
    await harness.runCommand("status");
    expect(harness.notifications.at(-1)?.message).toContain("inactive (configuration invalid)");
    expect(harness.notifications.at(-1)?.message).toContain("model=google/gemini-2.5-flash");
    expect(harness.notifications.at(-1)?.message).toContain("queued=0");
  });

  it("captures user prose, ignores assistant text, and drains after settled", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    createFluencyExtension(harness.deps)(harness.pi);

    await harness.emitInput("I made an mistake.");
    await harness.emitMessageEnd(assistantMessage("You made a mistake."));
    expect(harness.analyzer.analyze).not.toHaveBeenCalled();
    await harness.emitAgentSettled();
    await harness.waitForResult();
    expect(harness.analyzer.analyze).toHaveBeenCalledTimes(1);
    expect(harness.statuses.get("pi-fluency")).toBe(PENDING_ONE_STATUS);
    expect(harness.fakePi.eventEmissions.at(-1)).toEqual({
      channel: "powerbar:update",
      data: { id: "pi-fluency", text: "1  󰌵 0  ······▁ 0.0/k", icon: "󰇮", color: "warning" },
    });
  });

  it.each(["extension", "rpc"] as const)("ignores %s input", async (source) => {
    const harness = await createExtensionHarness({ enabled: true });
    createFluencyExtension(harness.deps)(harness.pi);

    await harness.emitInput("This generated prose contains an error.", source);
    await harness.emitAgentSettled();

    expect(harness.analyzer.analyze).not.toHaveBeenCalled();
  });

  it("ignores provenance-free finalized user messages", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    createFluencyExtension(harness.deps)(harness.pi);

    await harness.emitMessageEnd(userMessage("This generated prose contains an error."));
    await harness.emitAgentSettled();

    expect(harness.analyzer.analyze).not.toHaveBeenCalled();
  });

  it("keeps slash commands out of interactive analysis", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    createFluencyExtension(harness.deps)(harness.pi);

    await harness.emitInput("/ralph continue");
    await harness.emitAgentSettled();

    expect(harness.analyzer.analyze).not.toHaveBeenCalled();
  });

  it("includes accepted nonignored patterns in analyzer context", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    const store = await FluencyStore.open(harness.deps.rootDir);
    await store.appendAnalysis(collected("learned-seed", 100), oneMistake);
    const [pattern] = store.listInbox();
    await store.acceptPattern(pattern!.id, 110);
    createFluencyExtension(harness.deps)(harness.pi);

    await harness.emitInput("I made another language mistake.");
    await harness.emitAgentSettled();
    await harness.waitForResult();

    const knownPatterns = harness.analyzer.analyze.mock.calls[0]?.[1];
    expect(knownPatterns).toHaveLength(1);
    expect(knownPatterns?.[0]).toMatchObject({
      patternKey: oneMistake.mistakes[0]!.patternKey,
      errorType: "R:DET",
    });
  });

  it("publishes startup loading before resolving durable progress", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    createFluencyExtension(harness.deps)(harness.pi);

    await harness.emitSessionStart();
    const updates = harness.fakePi.eventEmissions.filter((event) => event.channel === "powerbar:update");
    expect(updates).toEqual([
      { channel: "powerbar:update", data: { id: "pi-fluency", text: "…  󰌵 …  ······· —/k", icon: "󰇰", color: "muted" } },
      { channel: "powerbar:update", data: { id: "pi-fluency", text: "0  󰌵 0  ······· —/k", icon: "󰇰", color: "success" } },
    ]);
  });

  it("keeps startup zero progress when the first prompt waits for analysis", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    createFluencyExtension(harness.deps)(harness.pi);

    await harness.emitSessionStart();
    expect(harness.statuses.get("pi-fluency")).toBe(EMPTY_STATUS);
    const startupProgress = harness.fakePi.eventEmissions.at(-1);
    expect(startupProgress).toEqual({
      channel: "powerbar:update",
      data: { id: "pi-fluency", text: "0  󰌵 0  ······· —/k", icon: "󰇰", color: "success" },
    });

    await harness.emitInput("I made an mistake.");
    expect(harness.statuses.get("pi-fluency")).toBe(EMPTY_STATUS);
    expect(harness.fakePi.eventEmissions.at(-1)).toBe(startupProgress);
    expect(harness.analyzer.analyze).not.toHaveBeenCalled();
  });

  it("keeps latest numeric status while a later prompt waits for analysis", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    const store = await FluencyStore.open(harness.deps.rootDir);
    await store.appendAnalysis(collected("latest", 100), oneMistake);
    createFluencyExtension(harness.deps)(harness.pi);
    await harness.emitSessionStart();

    await harness.emitInput("I made another language mistake in this prompt.");
    expect(harness.statuses.get("pi-fluency")).toBe(PENDING_ONE_STATUS);
    expect(harness.fakePi.eventEmissions.at(-1)).toEqual({
      channel: "powerbar:update",
      data: { id: "pi-fluency", text: "1  󰌵 0  ······▁ 0.0/k", icon: "󰇮", color: "warning" },
    });
  });

  it("publishes unclamped stock and Powerbar analytics without duplicating envelope icon", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    const store = await FluencyStore.open(harness.deps.rootDir);
    for (let index = 0; index < 12; index += 1) {
      await store.appendAnalysis(collected(`unclamped-${index}`, 100 + index), oneMistake);
    }
    createFluencyExtension(harness.deps)(harness.pi);

    await harness.emitSessionStart();
    expect(harness.statuses.get("pi-fluency")).toBe("󰇮 12  󰌵 0  ······▁ 0.0/k");
    expect(harness.fakePi.eventEmissions.at(-1)).toEqual({
      channel: "powerbar:update",
      data: { id: "pi-fluency", text: "12  󰌵 0  ······▁ 0.0/k", icon: "󰇮", color: "warning" },
    });
  });

  it("publishes durable progress from a compacted snapshot", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    const store = await FluencyStore.open(harness.deps.rootDir);
    const now = Date.now();
    await store.appendAnalysis(collected("seed", now), oneMistake);
    const [item] = store.listInbox();
    await store.acceptPattern(item!.id, now + 1);
    await store.compact();
    createFluencyExtension({ ...harness.deps, now: () => now })(harness.pi);

    await harness.emitSessionStart();
    expect(harness.statuses.get("pi-fluency")).toBe(ACCEPTED_SINGLETON_STATUS);
    expect(harness.fakePi.eventEmissions.at(-1)).toEqual({
      channel: "powerbar:update",
      data: { id: "pi-fluency", text: "0  󰌵 0  ······▄ 250.0/k", icon: "󰇰", color: "success" },
    });
  });

  it("analyzes repeated identical interactive prompts as distinct observations", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    createFluencyExtension(harness.deps)(harness.pi);
    const text = "This identical prompt contains an repeated grammar mistake.";

    await harness.emitInput(text);
    await harness.emitAgentSettled();
    await harness.waitForResult();
    await harness.emitInput(text);
    await harness.emitAgentSettled();

    await vi.waitFor(() => expect(harness.analyzer.analyze).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(harness.statuses.get("pi-fluency")).toContain("󰇮 2  󰌵 0"));
  });

  it("publishes global progress for repeats, acceptance, recurrence, and ignores", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    let progressChanged: (() => void) | undefined;
    let extensionStore: FluencyStore | undefined;
    const openInboxImpl: OpenInbox = async (_ctx, store, options) => {
      extensionStore = store;
      progressChanged = options.onProgressChanged;
      const [item] = store.listInbox();
      await store.acceptPattern(item!.id);
      options.onProgressChanged?.();
    };
    const openInbox = vi.fn(openInboxImpl);
    createFluencyExtension({ ...harness.deps, openInbox })(harness.pi);

    await harness.emitInput("I made an mistake.");
    await harness.emitAgentSettled();
    await harness.waitForResult();
    expect(harness.statuses.get("pi-fluency")).toBe(PENDING_ONE_STATUS);

    harness.analyzer.analyze.mockResolvedValueOnce(oneMistake);
    await harness.emitInput("This is another sufficiently long prompt with the same mistake.");
    await harness.emitAgentSettled();
    await vi.waitFor(() => expect(harness.analyzer.analyze).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(harness.statuses.get("pi-fluency")).toContain("󰇮 2  󰌵 0"));

    await harness.runCommand();
    expect(progressChanged).toBeTypeOf("function");
    expect(harness.statuses.get("pi-fluency")).toContain("󰇰 0  󰌵 1");

    harness.analyzer.analyze.mockResolvedValueOnce(oneMistake);
    await harness.emitInput("A third sufficiently long prompt repeats the learned mistake.");
    await harness.emitAgentSettled();
    await vi.waitFor(() => expect(harness.analyzer.analyze).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(harness.statuses.get("pi-fluency")).toContain("󰇮 1  󰌵 1"));

    await extensionStore!.ignorePatternKey(oneMistake.mistakes[0]!.patternKey);
    progressChanged?.();
    expect(harness.statuses.get("pi-fluency")).toContain("󰇰 0  󰌵 1");
  });

  it("rejects a malformed analyzer result without changing durable counts", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    createFluencyExtension(harness.deps)(harness.pi);
    await harness.emitInput("I made an mistake.");
    await harness.emitAgentSettled();
    await harness.waitForResult();

    harness.analyzer.analyze.mockResolvedValueOnce(malformedAnalysisFixture({
      schemaVersion: 1,
      mistakes: [],
      demonstratedFixes: [],
    }));
    await harness.emitInput("This sufficiently long generated prompt contains no reported findings.");
    await harness.emitAgentSettled();
    await vi.waitFor(() => expect(harness.analyzer.analyze).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(harness.statuses.get("pi-fluency")).toBe("󰅙 ERR store"));
    const persisted = await FluencyStore.open(harness.deps.rootDir);
    expect(persisted.listInbox()).toHaveLength(1);
    expect(persisted.listReviewPatterns().filter((item) => item.acceptedCount > 0)).toHaveLength(0);
  });

  it("publishes ERR without changing counts when an inbox persistence mutation fails", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    const seed = await FluencyStore.open(harness.deps.rootDir);
    await seed.appendAnalysis(collected("seed", 100), oneMistake);
    const openInboxImpl: OpenInbox = async (_ctx, _store, options) => {
      options.onMutationError?.(new Error("review write failed"));
    };
    const openInbox = vi.fn(openInboxImpl);
    createFluencyExtension({ ...harness.deps, openInbox })(harness.pi);
    await harness.emitSessionStart();

    await harness.runCommand();

    expect(harness.statuses.get("pi-fluency")).toBe("󰅙 ERR store");
    expect(harness.fakePi.eventEmissions.at(-1)).toEqual({
      channel: "powerbar:update",
      data: { id: "pi-fluency", text: "ERR store", icon: "󰅙", color: "error" },
    });
    expect(harness.notifications.at(-1)).toEqual({ message: "Pi Fluency: review write failed", type: "error" });
    const persisted = await FluencyStore.open(harness.deps.rootDir);
    expect(persisted.listInbox()).toHaveLength(1);
    expect(persisted.listReviewPatterns().filter((item) => item.acceptedCount > 0)).toHaveLength(0);
    expect(harness.fakePi.eventEmissions.filter((event) =>
      event.channel === "powerbar:update" && (event.data as { text?: string }).text === "0  󰌵 0  ······· —/k"
    )).toEqual([]);
  });

  it("republishes after dismiss and atomic ignore restoration", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    const seed = await FluencyStore.open(harness.deps.rootDir);
    await seed.appendAnalysis(collected("seed", 100), oneMistake);
    await seed.ignorePatternKey(oneMistake.mistakes[0]!.patternKey);
    let action: "restore" | "dismiss" = "restore";
    const openInboxImpl: OpenInbox = async (_ctx, store, options) => {
      if (action === "restore") {
        await store.restoreIgnoreTargets({ patternKeys: [oneMistake.mistakes[0]!.patternKey], categories: [] });
      } else {
        const [item] = store.listInbox();
        await store.dismissPattern(item!.id);
      }
      options.onProgressChanged?.();
    };
    const openInbox = vi.fn(openInboxImpl);
    createFluencyExtension({ ...harness.deps, openInbox })(harness.pi);
    await harness.emitSessionStart();
    expect(harness.statuses.get("pi-fluency")).toBe(ZERO_RATE_STATUS);

    await harness.runCommand();
    expect(harness.statuses.get("pi-fluency")).toBe(PENDING_ONE_STATUS);
    action = "dismiss";
    await harness.runCommand();
    expect(harness.statuses.get("pi-fluency")).toBe(ZERO_RATE_STATUS);
  });

  it("keeps ignored accepted singletons in the accepted rate", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    const store = await FluencyStore.open(harness.deps.rootDir);
    await store.appendAnalysis(collected("seed", 100), oneMistake);
    const [item] = store.listInbox();
    await store.acceptPattern(item!.id, 200);
    await store.ignoreCategory("DET");
    createFluencyExtension(harness.deps)(harness.pi);

    await harness.emitSessionStart();
    expect(harness.statuses.get("pi-fluency")).toBe(ACCEPTED_SINGLETON_STATUS);
  });

  it("publishes bounded migrate failure for pre-v4 history and recovers after confirmed clear", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    await writeFile(join(harness.deps.rootDir, "history.jsonl"), `${JSON.stringify({ schemaVersion: 3, type: "snapshot" })}\n`);
    createFluencyExtension(harness.deps)(harness.pi);

    await harness.emitSessionStart();
    expect(harness.statuses.get("pi-fluency")).toBe("󰅙 ERR migrate");
    expect(harness.fakePi.eventEmissions.at(-1)).toMatchObject({
      data: { icon: "󰅙", text: "ERR migrate", color: "error" },
    });
    expect(harness.notifications.filter((item) => item.type === "error").at(-1)?.message)
      .toContain("History migration required");

    await harness.runCommand("clear");
    expect(harness.statuses.get("pi-fluency")).toBe(EMPTY_STATUS);
  });

  it("publishes bounded model failure on unavailable configured model", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    const store = await FluencyStore.open(harness.deps.rootDir);
    await store.appendAnalysis(collected("latest", 100), oneMistake);
    createFluencyExtension(harness.deps)(harness.pi);
    harness.removeModel();

    await harness.emitSessionStart();
    expect(harness.statuses.get("pi-fluency")).toBe("󰅙 ERR model");
    expect(harness.fakePi.eventEmissions.at(-1)).toEqual({
      channel: "powerbar:update",
      data: { id: "pi-fluency", text: "ERR model", icon: "󰅙", color: "error" },
    });
    expect(harness.notifications.at(-1)?.message).toBe("Pi Fluency: Configured Pi Fluency model is unavailable");
  });

  it("awaits deferred abort cleanup across repeated shutdown and rejects later captures", async () => {
    const harness = await createExtensionHarness({ enabled: true, analyzerMode: "wait-for-abort-cleanup" });
    createFluencyExtension(harness.deps)(harness.pi);

    await harness.emitInput("I made an mistake.");
    await harness.emitAgentSettled();
    const firstShutdown = harness.emitSessionShutdown("reload");
    const secondShutdown = harness.emitSessionShutdown("reload");
    let firstSettled = false;
    let secondSettled = false;
    void firstShutdown.then(() => { firstSettled = true; });
    void secondShutdown.then(() => { secondSettled = true; });
    await Promise.resolve();
    expect(harness.abortObserved).toBe(true);
    expect(harness.cleanupFinished).toBe(false);
    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);

    harness.finishAbortCleanup();
    await Promise.all([firstShutdown, secondShutdown]);
    expect(harness.cleanupFinished).toBe(true);
    expect(firstSettled).toBe(true);
    expect(secondSettled).toBe(true);
    expect(harness.statuses.get("pi-fluency")).toBeUndefined();
    expect(harness.fakePi.eventEmissions.at(-1)).toEqual({
      channel: "powerbar:update",
      data: { id: "pi-fluency", text: undefined },
    });

    await harness.emitInput("This must never enter the stopped queue.");
    await harness.emitAgentSettled();
    expect(harness.analyzer.analyze).toHaveBeenCalledTimes(1);
  });

  it("clears again after an in-flight result finishes appending during shutdown", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    createFluencyExtension(harness.deps)(harness.pi);
    await harness.emitInput("I made an mistake.");

    const release = await lock(harness.deps.rootDir, { realpath: false });
    await harness.emitAgentSettled();
    await vi.waitFor(() => expect(harness.analyzer.analyze).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => setImmediate(resolve));

    const shutdown = harness.emitSessionShutdown("reload");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await release();
    await shutdown;

    expect(harness.statuses.get("pi-fluency")).toBeUndefined();
    expect(harness.fakePi.eventEmissions.at(-1)).toEqual({
      channel: "powerbar:update",
      data: { id: "pi-fluency", text: undefined },
    });
  });

  it("does not create a worker from messages received after shutdown", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    createFluencyExtension(harness.deps)(harness.pi);
    await harness.emitSessionShutdown("quit");

    await harness.emitInput("This must never be analyzed after shutdown.");
    await harness.emitAgentSettled();
    expect(harness.analyzer.analyze).not.toHaveBeenCalled();
    expect(harness.statuses.get("pi-fluency")).toBeUndefined();
  });

  it("maps remote analyzer failures to bounded analyze status", async () => {
    const harness = await createExtensionHarness({ enabled: true, analyzerMode: "wait-for-error" });
    createFluencyExtension(harness.deps)(harness.pi);
    await harness.emitInput("I made an mistake.");
    await harness.emitAgentSettled();

    vi.useFakeTimers();
    try {
      harness.rejectAnalysis(new Error("\u001b[31mdelayed analyzer failure\nretry"));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
      expect(harness.statuses.get("pi-fluency")).toBe("󰅙 ERR analyze");
      expect(harness.fakePi.eventEmissions.at(-1)).toMatchObject({
        data: { icon: "󰅙", text: "ERR analyze", color: "error" },
      });
      expect(harness.notifications.filter((item) => item.type === "error").at(-1)?.message)
        .toBe("Pi Fluency: delayed analyzer failureretry");
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps delayed analyzer errors to model after configured model becomes unavailable", async () => {
    const harness = await createExtensionHarness({ enabled: true, analyzerMode: "wait-for-error" });
    createFluencyExtension(harness.deps)(harness.pi);
    await harness.emitInput("I made an mistake.");
    await harness.emitAgentSettled();
    expect(harness.analyzer.analyze).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    try {
      harness.removeModel();
      harness.rejectAnalysis();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
      expect(harness.analyzer.analyze).toHaveBeenCalledTimes(2);
      expect(harness.statuses.get("pi-fluency")).toBe("󰅙 ERR model");
      expect(harness.notifications.filter((item) => item.type === "error").at(-1)?.message)
        .toBe("Pi Fluency: Configured Pi Fluency model is unavailable");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps provider configuration and consent unchanged when model disclosure is declined", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    harness.confirm.mockResolvedValueOnce(false);
    createFluencyExtension(harness.deps)(harness.pi);

    await harness.runCommand("model");
    const settings = JSON.parse(await readFile(join(harness.deps.rootDir, "settings.json"), "utf8")) as Record<string, unknown>;
    expect(settings).toMatchObject({ provider: "google", modelId: "gemini-2.5-flash", consentedAt: 1 });
    expect(harness.notifications.some((item) => item.message.startsWith("Pi Fluency model:"))).toBe(false);
  });

  it("requires fresh provider disclosure approval for model changes", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    createFluencyExtension(harness.deps)(harness.pi);

    await harness.runCommand("model");
    expect(harness.confirm).toHaveBeenCalledWith(
      "Enable Pi Fluency?",
      expect.stringContaining("will be sent to google/gemini-2.5-flash"),
    );
    const settings = JSON.parse(await readFile(join(harness.deps.rootDir, "settings.json"), "utf8")) as Record<string, unknown>;
    expect(settings).toMatchObject({ provider: "google", modelId: "gemini-2.5-flash", consentedAt: 123 });
  });

  it("runs first-use model selection and consent from /fluency", async () => {
    const harness = await createExtensionHarness({ enabled: false });
    createFluencyExtension(harness.deps)(harness.pi);

    await harness.runCommand();
    expect(harness.select).toHaveBeenCalledWith("Pi Fluency analyzer model", ["google/gemini-2.5-flash"]);
    expect(harness.confirm).toHaveBeenCalledWith(
      "Enable Pi Fluency?",
      expect.stringContaining("Code, commands, assistant text, and tool output are excluded"),
    );
    expect(harness.confirm).toHaveBeenCalledWith(
      "Enable Pi Fluency?",
      expect.stringContaining("Raw prompt bodies are not stored; bounded sanitized excerpts may equal a short prompt"),
    );
    const settings = JSON.parse(await readFile(join(harness.deps.rootDir, "settings.json"), "utf8")) as Record<string, unknown>;
    expect(settings).toMatchObject({ enabled: true, provider: "google", modelId: "gemini-2.5-flash" });
    expect(settings.consentedAt).toEqual(expect.any(Number));
    expect(harness.statuses.get("pi-fluency")).toBe(EMPTY_STATUS);
    expect(harness.fakePi.eventEmissions.at(-1)).toEqual({
      channel: "powerbar:update",
      data: { id: "pi-fluency", text: "0  󰌵 0  ······· —/k", icon: "󰇰", color: "success" },
    });
  });

  it("does not enable when setup consent is declined", async () => {
    const harness = await createExtensionHarness({ enabled: false });
    harness.confirm.mockResolvedValueOnce(false);
    createFluencyExtension(harness.deps)(harness.pi);

    await harness.runCommand();
    await harness.emitInput("I made an mistake.");
    await harness.emitAgentSettled();
    expect(harness.analyzer.analyze).not.toHaveBeenCalled();
  });

  it("supports pause, resume, status, model, and confirmed clear", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    createFluencyExtension(harness.deps)(harness.pi);

    await harness.runCommand("pause");
    await harness.emitInput("I made an mistake.");
    await harness.emitAgentSettled();
    expect(harness.analyzer.analyze).not.toHaveBeenCalled();
    expect(harness.statuses.get("pi-fluency")).toBeUndefined();

    await harness.runCommand("resume");
    await harness.runCommand("model");
    expect(harness.select).toHaveBeenCalledWith("Pi Fluency analyzer model", ["google/gemini-2.5-flash"]);
    await harness.runCommand("status");
    expect(harness.notifications.at(-1)?.message).toContain("enabled; model=google/gemini-2.5-flash; queued=0; dropped=0; warnings=0");

    await harness.emitInput("I made an mistake.");
    await harness.emitAgentSettled();
    await vi.waitFor(() => expect(harness.analyzer.analyze).toHaveBeenCalledOnce());
    await vi.waitFor(async () => expect((await readFile(join(harness.deps.rootDir, "history.jsonl"), "utf8")).trim()).not.toBe(""));
    harness.confirm.mockResolvedValueOnce(false);
    await harness.runCommand("clear");
    expect((await readFile(join(harness.deps.rootDir, "history.jsonl"), "utf8")).trim()).not.toBe("");
    harness.confirm.mockResolvedValueOnce(true);
    await harness.runCommand("clear");
    expect(await readFile(join(harness.deps.rootDir, "history.jsonl"), "utf8")).toBe("");
    expect(harness.statuses.get("pi-fluency")).toBe(EMPTY_STATUS);
    expect(harness.fakePi.eventEmissions.at(-1)).toEqual({
      channel: "powerbar:update",
      data: { id: "pi-fluency", text: "0  󰌵 0  ······· —/k", icon: "󰇰", color: "success" },
    });
  });

  it.each([
    { state: "paused", prepare: async (harness: Awaited<ReturnType<typeof createExtensionHarness>>) => harness.runCommand("pause") },
    { state: "invalid", prepare: async (harness: Awaited<ReturnType<typeof createExtensionHarness>>) => { harness.removeModel(); } },
  ])("keeps status hidden after confirmed clear while $state", async ({ prepare }) => {
    const harness = await createExtensionHarness({ enabled: true });
    const store = await FluencyStore.open(harness.deps.rootDir);
    await store.appendAnalysis(collected("seed", 100), oneMistake);
    createFluencyExtension(harness.deps)(harness.pi);
    await prepare(harness);
    harness.confirm.mockResolvedValueOnce(true);

    await harness.runCommand("clear");

    expect(harness.statuses.get("pi-fluency")).toBeUndefined();
    expect(harness.fakePi.eventEmissions.at(-1)).toEqual({
      channel: "powerbar:update",
      data: { id: "pi-fluency", text: undefined },
    });
  });

  it("reports configured but unavailable model as inactive", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    createFluencyExtension(harness.deps)(harness.pi);
    harness.removeModel();

    await harness.runCommand("status");
    expect(harness.notifications.at(-1)?.message).toContain(
      "inactive (configuration invalid); model=google/gemini-2.5-flash",
    );
  });

  it("requires prior consent and an available model to resume", async () => {
    const harness = await createExtensionHarness({ enabled: false });
    createFluencyExtension(harness.deps)(harness.pi);

    await harness.runCommand("resume");
    expect(harness.notifications.at(-1)).toMatchObject({ type: "warning" });
    await harness.emitInput("I made an mistake.");
    await harness.emitAgentSettled();
    expect(harness.analyzer.analyze).not.toHaveBeenCalled();
  });

  it.each(["paused", "model unavailable"] as const)("opens /fluency stats directly on local history while %s", async (state) => {
    const openInboxImpl: OpenInbox = async (_ctx, _store, options) => {
      expect(options.initialView).toBe("stats");
      expect(options.signal).toBeInstanceOf(AbortSignal);
    };
    const openInbox = vi.fn(openInboxImpl);
    const harness = await createExtensionHarness({ enabled: state !== "paused" });
    createFluencyExtension({ ...harness.deps, openInbox })(harness.pi);
    if (state === "model unavailable") harness.removeModel();

    await harness.runCommand("stats");
    expect(openInbox).toHaveBeenCalledOnce();
  });

  it("passes common ExtensionContext to injected inbox from command and shortcut", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    const receivedContexts: Array<{ mode: string; hasUI: boolean }> = [];
    const openInboxImpl: OpenInbox = async (ctx) => {
      receivedContexts.push({ mode: ctx.mode, hasUI: ctx.hasUI });
    };
    const openInbox = vi.fn(openInboxImpl);
    createFluencyExtension({ ...harness.deps, openInbox })(harness.pi);

    await harness.runCommand();
    await harness.runShortcut();
    expect(openInbox).toHaveBeenCalledTimes(2);
    expect(receivedContexts).toEqual([
      { mode: "tui", hasUI: true },
      { mode: "tui", hasUI: true },
    ]);
    expect(harness.fakePi.shortcuts.has("ctrl+shift+l")).toBe(true);
  });

  it("opens the built-in overlay when inbox is not injected", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    createFluencyExtension(harness.deps)(harness.pi);

    await harness.runCommand();
    expect(harness.custom).toHaveBeenCalledOnce();
    expect(harness.custom.mock.calls[0]?.[1]).toEqual({
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "75%",
        minWidth: 56,
        maxHeight: "80%",
        margin: 1,
        visible: expect.any(Function),
      },
    });
  });

  it("aborts and awaits an open inbox during every shutdown path", async () => {
    for (const reason of ["quit", "reload", "new", "resume", "fork"] as const) {
      const harness = await createExtensionHarness({ enabled: true });
      let aborted = false;
      const openInboxImpl: OpenInbox = (_ctx, _store, options) => new Promise<void>((resolve) => {
        options.signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true });
      });
      const openInbox = vi.fn(openInboxImpl);
      createFluencyExtension({ ...harness.deps, openInbox })(harness.pi);
      const opening = harness.runCommand();
      await vi.waitFor(() => expect(openInbox).toHaveBeenCalledOnce());

      await harness.emitSessionShutdown(reason);
      await opening;
      expect(aborted).toBe(true);
      await harness.runShortcut();
      expect(openInbox).toHaveBeenCalledOnce();
    }
  });

  it("coalesces command and shortcut while inbox is open", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    let close!: () => void;
    const openInboxImpl: OpenInbox = () => new Promise<void>((resolve) => { close = resolve; });
    const openInbox = vi.fn(openInboxImpl);
    createFluencyExtension({ ...harness.deps, openInbox })(harness.pi);

    const command = harness.runCommand();
    await vi.waitFor(() => expect(openInbox).toHaveBeenCalledOnce());
    const shortcut = harness.runShortcut();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(openInbox).toHaveBeenCalledOnce();
    close();
    await Promise.all([command, shortcut]);
  });

  it("uses the warning Powerbar icon if and only if progress is pending", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    const store = await FluencyStore.open(harness.deps.rootDir);
    await store.appendAnalysis(collected("seed", 100), oneMistake);
    createFluencyExtension(harness.deps)(harness.pi);
    await harness.emitSessionStart();
    expect(harness.fakePi.eventEmissions.at(-1)).toMatchObject({ data: { icon: "󰇮", color: "warning" } });

    const [item] = store.listInbox();
    await store.acceptPattern(item!.id);
    await harness.runCommand("resume");
    expect(harness.statuses.get("pi-fluency")).toBe(ACCEPTED_SINGLETON_STATUS);
    expect(harness.fakePi.eventEmissions.at(-1)).toMatchObject({ data: { icon: "󰇰", color: "success" } });
  });

  it("persists ignored results but excludes ignored patterns and categories from status", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    await writeFile(join(harness.deps.rootDir, "settings.json"), JSON.stringify({
      ...DEFAULT_SETTINGS,
      enabled: true,
      consentedAt: 1,
      provider: "google",
      modelId: "gemini-2.5-flash",
      ignoredCategories: ["DET"],
    }));
    createFluencyExtension(harness.deps)(harness.pi);

    await harness.emitInput("I made an mistake.");
    await harness.emitAgentSettled();
    await harness.waitForResult();
    expect(harness.statuses.get("pi-fluency")).toBe(ZERO_RATE_STATUS);
    const reopened = await FluencyStore.open(harness.deps.rootDir);
    expect(reopened.listIgnored()).toHaveLength(1);
  });

  it("retains queued prompts on auth configuration failure and drains after recovery", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    let configured = false;
    const analyze = vi.fn(async () => {
      if (!configured) throw new AnalyzerConfigurationError("No API key for google");
      return oneMistake;
    });
    createFluencyExtension({ ...harness.deps, analyzerFactory: () => ({ analyze }) })(harness.pi);

    await harness.emitInput("I made an mistake.");
    await harness.emitAgentSettled();
    expect(analyze).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(harness.statuses.get("pi-fluency")).toBe("󰅙 ERR auth"));
    expect(harness.fakePi.eventEmissions.at(-1)).toMatchObject({
      data: { icon: "󰅙", text: "ERR auth", color: "error" },
    });
    await harness.runCommand("status");
    expect(harness.notifications.at(-1)?.message).toContain("queued=1");

    configured = true;
    await harness.emitAgentSettled();
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(harness.statuses.get("pi-fluency")).toBe(PENDING_ONE_STATUS));
    await harness.runCommand("status");
    expect(harness.notifications.at(-1)?.message).toContain("queued=0");
  });

  it("opens Practice directly and supports consented on/off, resume, reset, and status", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    const openInbox = vi.fn<OpenInbox>(async (_ctx, _store, options) => {
      expect(options.initialView).toBe("practice");
    });
    createFluencyExtension({ ...harness.deps, openInbox })(harness.pi);

    await harness.runCommand("practice");
    expect(openInbox).toHaveBeenCalledOnce();

    harness.confirm.mockResolvedValueOnce(false);
    await harness.runCommand("practice on");
    let practice = (await FluencyStore.open(harness.deps.rootDir)).getPracticeSettings();
    expect(practice.enabled).toBe(false);
    expect(practice.consentedAt).toBeUndefined();

    harness.confirm.mockResolvedValueOnce(true);
    await harness.runCommand("practice on");
    practice = (await FluencyStore.open(harness.deps.rootDir)).getPracticeSettings();
    expect(practice.enabled).toBe(true);
    expect(practice.consentedAt).toBe(123);

    await harness.runCommand("practice off");
    await harness.runCommand("practice resume");
    await harness.runCommand("status");
    expect(harness.notifications.at(-1)?.message).toContain("practice=off; practice-selected=0; practice-snooze=none");

    harness.confirm.mockResolvedValueOnce(true);
    await harness.runCommand("practice reset");
    practice = (await FluencyStore.open(harness.deps.rootDir)).getPracticeSettings();
    expect(practice).toMatchObject({ enabled: false, targets: [], epoch: 1 });
    expect(practice.consentedAt).toBeUndefined();
  });

  it("blocks a selected match on Edit, preserves exact received text, and persists nothing", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    const store = await FluencyStore.open(harness.deps.rootDir);
    await store.activatePractice(2, {
      explanation: oneMistake.mistakes[0]!.explanation,
      memberPatternKeys: [oneMistake.mistakes[0]!.patternKey],
    });
    const received = "I made an mistake.\n\nKeep exact spacing here.";
    const showCoaching = vi.fn(async (_ctx, check) => {
      expect(await check).toMatchObject({ kind: "matches" });
      return "edit" as const;
    });
    createFluencyExtension({ ...harness.deps, showCoaching })(harness.pi);

    expect(await harness.emitInput(received)).toEqual({ action: "handled" });
    expect(harness.editorText).toBe(received);
    expect(harness.editorWrites).toEqual([received]);
    expect(harness.analyzer.analyze).toHaveBeenCalledTimes(1);
    const reopened = await FluencyStore.open(harness.deps.rootDir);
    expect(reopened.getAnalyticsSnapshot().observations).toEqual([]);
    expect(await readFile(join(harness.deps.rootDir, "practice.json"), "utf8")).not.toContain(received);
  });

  it("sends once after a selected match, clears restored editor, and conditionally commits once", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    const store = await FluencyStore.open(harness.deps.rootDir);
    await store.activatePractice(2, {
      explanation: oneMistake.mistakes[0]!.explanation,
      memberPatternKeys: [oneMistake.mistakes[0]!.patternKey],
    });
    const showCoaching = vi.fn(async (_ctx, check) => {
      expect((await check).kind).toBe("matches");
      return "send-once" as const;
    });
    createFluencyExtension({ ...harness.deps, showCoaching })(harness.pi);

    expect(await harness.emitInput("I made an mistake in this longer prompt.")).toEqual({ action: "continue" });
    expect(harness.editorText).toBe("");
    expect(harness.editorWrites.at(-1)).toBe("");
    await vi.waitFor(async () => {
      expect((await FluencyStore.open(harness.deps.rootDir)).getAnalyticsSnapshot().observations).toHaveLength(1);
    });
    expect(harness.analyzer.analyze).toHaveBeenCalledTimes(1);
  });

  it("rechecks edited resubmission and allows clean full analysis without duplicate provider work", async () => {
    const clean: AnalysisResult = { schemaVersion: 3, language: "en", mistakes: [], demonstratedFixes: [] };
    const harness = await createExtensionHarness({ enabled: true });
    harness.analyzer.analyze.mockResolvedValueOnce(oneMistake).mockResolvedValueOnce(clean);
    const store = await FluencyStore.open(harness.deps.rootDir);
    await store.activatePractice(2, {
      explanation: oneMistake.mistakes[0]!.explanation,
      memberPatternKeys: [oneMistake.mistakes[0]!.patternKey],
    });
    const showCoaching = vi.fn(async (_ctx, check) => (await check).kind === "matches" ? "edit" as const : "clean" as const);
    createFluencyExtension({ ...harness.deps, showCoaching })(harness.pi);

    expect(await harness.emitInput("I made an mistake in this first draft.")).toEqual({ action: "handled" });
    expect(await harness.emitInput("I fixed the article in this edited clean draft.")).toEqual({ action: "continue" });
    await vi.waitFor(async () => {
      expect((await FluencyStore.open(harness.deps.rootDir)).getAnalyticsSnapshot().observations).toHaveLength(1);
    });
    expect(harness.analyzer.analyze).toHaveBeenCalledTimes(2);
  });

  it("snoozes current conversation after sending and bypasses its later preflight", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    const store = await FluencyStore.open(harness.deps.rootDir);
    await store.activatePractice(2, {
      explanation: oneMistake.mistakes[0]!.explanation,
      memberPatternKeys: [oneMistake.mistakes[0]!.patternKey],
    });
    const showCoaching = vi.fn(async (_ctx, check) => {
      await check;
      return "snooze-session" as const;
    });
    createFluencyExtension({ ...harness.deps, showCoaching })(harness.pi);

    expect(await harness.emitInput("I made an mistake in this first prompt.")).toEqual({ action: "continue" });
    expect(await harness.emitInput("I made an mistake in this later prompt.")).toEqual({ action: "continue" });
    expect(showCoaching).toHaveBeenCalledTimes(1);
    expect(harness.analyzer.analyze).toHaveBeenCalledTimes(1);
    await harness.emitAgentSettled();
    await vi.waitFor(() => expect(harness.analyzer.analyze).toHaveBeenCalledTimes(2));
  });

  it("keeps snooze terminal winner when shutdown races in-flight persistence", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    const store = await FluencyStore.open(harness.deps.rootDir);
    await store.activatePractice(2, {
      explanation: oneMistake.mistakes[0]!.explanation,
      memberPatternKeys: [oneMistake.mistakes[0]!.patternKey],
    });
    let component!: CoachingOverlay;
    harness.custom.mockImplementation((factory: Function) => new Promise<void>((resolve) => {
      component = factory(
        { requestRender: vi.fn(), terminal: { rows: 30 } },
        undefined,
        { matches: () => false },
        resolve,
      );
    }) as never);
    const prototype = FluencyStore.prototype;
    const original = prototype.snoozePracticeForFiveHours;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    prototype.snoozePracticeForFiveHours = function (...args) {
      return gate.then(() => original.apply(this, args));
    };
    try {
      createFluencyExtension(harness.deps)(harness.pi);
      let inputSettled = false;
      const input = harness.emitInput("I made an mistake before shutdown race.")
        .finally(() => { inputSettled = true; });
      await vi.waitFor(() => expect(component).toBeDefined());
      await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("Practice check"));
      component.handleInput("5");
      await harness.emitSessionShutdown("reload");
      expect(inputSettled).toBe(false);
      release();
      expect(await input).toEqual({ action: "continue" });
      expect((await FluencyStore.open(harness.deps.rootDir)).getPracticeSettings().snoozedUntil).toBe(123 + 5 * 60 * 60 * 1_000);
    } finally {
      prototype.snoozePracticeForFiveHours = original;
    }
  });

  it("restores conversation snooze through recreated extension for same session file", async () => {
    const first = await createExtensionHarness({ enabled: true });
    const store = await FluencyStore.open(first.deps.rootDir);
    await store.activatePractice(2, {
      explanation: oneMistake.mistakes[0]!.explanation,
      memberPatternKeys: [oneMistake.mistakes[0]!.patternKey],
    });
    createFluencyExtension({
      ...first.deps,
      showCoaching: async (_ctx, check) => {
        await check;
        return "snooze-session";
      },
    })(first.pi);
    expect(await first.emitInput("I made an mistake before reload.")).toEqual({ action: "continue" });
    await first.emitSessionShutdown("reload");

    const second = await createExtensionHarness({
      enabled: true,
      rootDir: first.deps.rootDir,
      sessionEntries: first.sessionEntries,
    });
    const showCoaching = vi.fn(async () => "edit" as const);
    createFluencyExtension({ ...second.deps, showCoaching })(second.pi);
    expect(await second.emitInput("I made an mistake after same-file reload.")).toEqual({ action: "continue" });
    expect(showCoaching).not.toHaveBeenCalled();
    expect(second.analyzer.analyze).not.toHaveBeenCalled();
    await second.emitAgentSettled();
    await vi.waitFor(() => expect(second.analyzer.analyze).toHaveBeenCalledOnce());
  });

  it("activates durable five-hour snooze, bypasses later checks, and Resume now clears it", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    const store = await FluencyStore.open(harness.deps.rootDir);
    await store.activatePractice(2, {
      explanation: oneMistake.mistakes[0]!.explanation,
      memberPatternKeys: [oneMistake.mistakes[0]!.patternKey],
    });
    const showCoaching = vi.fn(async (_ctx, check) => {
      await check;
      return "snooze-five-hours" as const;
    });
    createFluencyExtension({ ...harness.deps, showCoaching })(harness.pi);

    expect(await harness.emitInput("I made an mistake before global snooze.")).toEqual({ action: "continue" });
    const durable = await FluencyStore.open(harness.deps.rootDir);
    expect(durable.getPracticeSettings().snoozedUntil).toBe(123 + 5 * 60 * 60 * 1_000);
    expect(await harness.emitInput("I made an mistake during global snooze.")).toEqual({ action: "continue" });
    expect(showCoaching).toHaveBeenCalledTimes(1);

    await harness.runCommand("practice resume");
    expect((await FluencyStore.open(harness.deps.rootDir)).getPracticeSettings().snoozedUntil).toBeUndefined();
  });

  it("bypasses foreground for ignored-only targets and retains background analytics", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    const store = await FluencyStore.open(harness.deps.rootDir);
    const patternKey = oneMistake.mistakes[0]!.patternKey;
    await store.activatePractice(2, {
      explanation: oneMistake.mistakes[0]!.explanation,
      memberPatternKeys: [patternKey],
    });
    await store.updateSettings({ ignoredPatternKeys: [patternKey] });
    const showCoaching = vi.fn(async () => "edit" as const);
    createFluencyExtension({ ...harness.deps, showCoaching })(harness.pi);

    expect(await harness.emitInput("I made an mistake ignored by practice.")).toEqual({ action: "continue" });
    expect(showCoaching).not.toHaveBeenCalled();
    expect(harness.analyzer.analyze).not.toHaveBeenCalled();
    await harness.emitAgentSettled();
    await vi.waitFor(() => expect(harness.analyzer.analyze).toHaveBeenCalledOnce());
  });

  it("keeps images and active-stream input outside preflight while retaining background analytics", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    const store = await FluencyStore.open(harness.deps.rootDir);
    await store.activatePractice(2, {
      explanation: oneMistake.mistakes[0]!.explanation,
      memberPatternKeys: [oneMistake.mistakes[0]!.patternKey],
    });
    const showCoaching = vi.fn(async () => "edit" as const);
    createFluencyExtension({ ...harness.deps, showCoaching })(harness.pi);

    expect(await harness.emitInput("Image-bearing prose has an mistake.", "interactive", { images: [{}] })).toBeUndefined();
    expect(await harness.emitInput("Steering prose also has an mistake.", "interactive", { streamingBehavior: "steer" })).toBeUndefined();
    expect(showCoaching).not.toHaveBeenCalled();
    expect(harness.editorWrites).toEqual([]);
    await harness.emitAgentSettled();
    await vi.waitFor(() => expect(harness.analyzer.analyze).toHaveBeenCalledTimes(2));
  });

  it("continues original event without starting preflight when initial editor preservation fails", async () => {
    const harness = await createExtensionHarness({ enabled: true, editorFailure: "preserve" });
    const store = await FluencyStore.open(harness.deps.rootDir);
    await store.activatePractice(2, {
      explanation: oneMistake.mistakes[0]!.explanation,
      memberPatternKeys: [oneMistake.mistakes[0]!.patternKey],
    });
    const showCoaching = vi.fn(async () => "edit" as const);
    createFluencyExtension({ ...harness.deps, showCoaching })(harness.pi);

    expect(await harness.emitInput("I made an mistake in this preserved prompt.")).toBeUndefined();
    expect(showCoaching).not.toHaveBeenCalled();
    expect(harness.analyzer.analyze).not.toHaveBeenCalled();
  });

  it("handles instead of sending when final editor clear fails", async () => {
    const harness = await createExtensionHarness({ enabled: true, editorFailure: "clear" });
    const store = await FluencyStore.open(harness.deps.rootDir);
    await store.activatePractice(2, {
      explanation: oneMistake.mistakes[0]!.explanation,
      memberPatternKeys: [oneMistake.mistakes[0]!.patternKey],
    });
    const showCoaching = vi.fn(async (_ctx, check) => {
      await check;
      return "send-once" as const;
    });
    createFluencyExtension({ ...harness.deps, showCoaching })(harness.pi);
    const text = "I made an mistake in this retained prompt.";

    expect(await harness.emitInput(text)).toEqual({ action: "handled" });
    expect(harness.editorText).toBe(text);
    expect(harness.notifications.at(-1)?.message).toBe("Not sent — editor could not be cleared.");
    expect((await FluencyStore.open(harness.deps.rootDir)).getAnalyticsSnapshot().observations).toEqual([]);
  });

  it("never queues a prompt when consent is revoked after final read but before conditional append", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    const store = await FluencyStore.open(harness.deps.rootDir);
    await store.activatePractice(2, {
      explanation: oneMistake.mistakes[0]!.explanation,
      memberPatternKeys: [oneMistake.mistakes[0]!.patternKey],
    });
    const showCoaching = vi.fn(async (_ctx, check) => {
      await check;
      return "send-once" as const;
    });
    const prototype = FluencyStore.prototype;
    const original = prototype.conditionalAppendAnalysis;
    const pause = vi.fn(async () => {
      await (await FluencyStore.open(harness.deps.rootDir)).updateSettings({ enabled: false });
    });
    prototype.conditionalAppendAnalysis = function (...args) {
      return pause().then(() => original.apply(this, args));
    };
    try {
      createFluencyExtension({ ...harness.deps, showCoaching })(harness.pi);
      expect(await harness.emitInput("I made an mistake before append-time revocation.")).toEqual({ action: "continue" });
      await vi.waitFor(() => expect(pause).toHaveBeenCalledOnce());
      await harness.emitAgentSettled();
      expect(harness.analyzer.analyze).toHaveBeenCalledTimes(1);
      expect((await FluencyStore.open(harness.deps.rootDir)).getAnalyticsSnapshot().observations).toEqual([]);
    } finally {
      prototype.conditionalAppendAnalysis = original;
    }
  });

  it("does not enqueue background work when consent is revoked during foreground analysis", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    let resolveAnalysis!: (result: AnalysisResult) => void;
    harness.analyzer.analyze.mockImplementationOnce(() => new Promise((resolve) => { resolveAnalysis = resolve; }));
    const store = await FluencyStore.open(harness.deps.rootDir);
    await store.activatePractice(2, {
      explanation: oneMistake.mistakes[0]!.explanation,
      memberPatternKeys: [oneMistake.mistakes[0]!.patternKey],
    });
    const showCoaching = vi.fn(async (_ctx, check) => {
      expect((await check).kind).toBe("failure");
      return "technical-failure" as const;
    });
    createFluencyExtension({ ...harness.deps, showCoaching })(harness.pi);

    const input = harness.emitInput("I made an mistake before consent is revoked.");
    await vi.waitFor(() => expect(harness.analyzer.analyze).toHaveBeenCalledOnce());
    await (await FluencyStore.open(harness.deps.rootDir)).updateSettings({ enabled: false });
    resolveAnalysis(oneMistake);
    expect(await input).toEqual({ action: "continue" });
    await harness.emitAgentSettled();
    expect(harness.analyzer.analyze).toHaveBeenCalledTimes(1);
    expect((await FluencyStore.open(harness.deps.rootDir)).getAnalyticsSnapshot().observations).toEqual([]);
  });

  it("reports five-hour snooze not activated after authoritative absent reread", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    const store = await FluencyStore.open(harness.deps.rootDir);
    await store.activatePractice(2, {
      explanation: oneMistake.mistakes[0]!.explanation,
      memberPatternKeys: [oneMistake.mistakes[0]!.patternKey],
    });
    const prototype = FluencyStore.prototype;
    const original = prototype.snoozePracticeForFiveHours;
    prototype.snoozePracticeForFiveHours = vi.fn(async () => false);
    const showCoaching = vi.fn(async (_ctx, check, _signal, saveSnooze) => {
      await check;
      await saveSnooze!("snooze-five-hours");
      return "snooze-five-hours" as const;
    });
    try {
      createFluencyExtension({ ...harness.deps, showCoaching })(harness.pi);
      expect(await harness.emitInput("I made an mistake before rejected snooze.")).toEqual({ action: "continue" });
      expect(harness.notifications.map((item) => item.message)).toContain(
        "Sent once; 5-hour snooze was not activated.",
      );
    } finally {
      prototype.snoozePracticeForFiveHours = original;
    }
  });

  it("uses one absolute snooze deadline and reports unknown after it expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const harness = await createExtensionHarness({ enabled: true });
    const store = await FluencyStore.open(harness.deps.rootDir);
    await store.activatePractice(2, {
      explanation: oneMistake.mistakes[0]!.explanation,
      memberPatternKeys: [oneMistake.mistakes[0]!.patternKey],
    });
    const prototype = FluencyStore.prototype;
    const original = prototype.snoozePracticeForFiveHours;
    const snooze = vi.fn(() => new Promise<boolean>(() => undefined));
    prototype.snoozePracticeForFiveHours = snooze;
    const showCoaching = vi.fn(async (_ctx, check, _signal, saveSnooze) => {
      await check;
      await saveSnooze!("snooze-five-hours");
      return "snooze-five-hours" as const;
    });
    try {
      createFluencyExtension({ ...harness.deps, showCoaching })(harness.pi);
      const input = harness.emitInput("I made an mistake before a timed-out snooze.");
      await vi.waitFor(() => expect(snooze).toHaveBeenCalledOnce());
      const beforeDeadlineTimer = Date.now();
      await vi.advanceTimersToNextTimerAsync();
      expect(await input).toEqual({ action: "continue" });
      expect(harness.notifications.map((item) => item.message)).toContain(
        "Sent once; snooze state unknown — use /fluency practice resume.",
      );
      expect(Date.now() - beforeDeadlineTimer).toBeLessThanOrEqual(1_000);
    } finally {
      prototype.snoozePracticeForFiveHours = original;
      vi.useRealTimers();
    }
  });

  it("fails open through public extension seam when coaching UI rejects", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    const store = await FluencyStore.open(harness.deps.rootDir);
    await store.activatePractice(2, {
      explanation: oneMistake.mistakes[0]!.explanation,
      memberPatternKeys: [oneMistake.mistakes[0]!.patternKey],
    });
    const showCoaching = vi.fn(async () => { throw new Error("overlay failed"); });
    createFluencyExtension({ ...harness.deps, showCoaching })(harness.pi);

    expect(await harness.emitInput("I made an mistake while overlay fails.")).toEqual({ action: "continue" });
    expect(harness.editorText).toBe("");
    expect(harness.notifications.at(-1)?.message).toBe("Sent without practice check — analyzer busy/timed out/failed.");
    expect((await FluencyStore.open(harness.deps.rootDir)).getAnalyticsSnapshot().observations).toEqual([]);
  });

  it("fails open after foreground timeout through public extension seam", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const harness = await createExtensionHarness({ enabled: true, analyzerMode: "wait-for-abort" });
    const store = await FluencyStore.open(harness.deps.rootDir);
    await store.activatePractice(2, {
      explanation: oneMistake.mistakes[0]!.explanation,
      memberPatternKeys: [oneMistake.mistakes[0]!.patternKey],
    });
    const showCoaching = vi.fn(async (_ctx, check) => {
      expect((await check).kind).toBe("failure");
      return "technical-failure" as const;
    });
    try {
      createFluencyExtension({ ...harness.deps, showCoaching })(harness.pi);
      const input = harness.emitInput("I made an mistake until foreground timeout.");
      await vi.waitFor(() => expect(harness.analyzer.analyze).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(6_100);
      expect(await input).toEqual({ action: "continue" });
      expect(harness.abortObserved).toBe(true);
      expect(harness.notifications.at(-1)?.message).toBe("Sent without practice check — analyzer busy/timed out/failed.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets checking Send unchecked win analyzer cancellation without a foreground commit", async () => {
    const harness = await createExtensionHarness({ enabled: true, analyzerMode: "wait-for-abort" });
    const store = await FluencyStore.open(harness.deps.rootDir);
    await store.activatePractice(2, {
      explanation: oneMistake.mistakes[0]!.explanation,
      memberPatternKeys: [oneMistake.mistakes[0]!.patternKey],
    });
    const showCoaching = vi.fn(async () => "send-unchecked" as const);
    createFluencyExtension({ ...harness.deps, showCoaching })(harness.pi);

    expect(await harness.emitInput("I made an mistake while checking is active.")).toEqual({ action: "continue" });
    expect(harness.abortObserved).toBe(true);
    expect(harness.editorText).toBe("");
    expect((await FluencyStore.open(harness.deps.rootDir)).getAnalyticsSnapshot().observations).toEqual([]);
  });

  it("rejects unknown command arguments with usage", async () => {
    const harness = await createExtensionHarness({ enabled: true });
    createFluencyExtension(harness.deps)(harness.pi);
    await harness.runCommand("wat");
    expect(harness.notifications.at(-1)).toEqual({
      message: "Usage: /fluency [pause|resume|status|model|clear|stats|practice [on|off|resume|reset]]",
      type: "warning",
    });
  });
});
