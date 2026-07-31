import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { AnalyzerConfigurationError, ModelAnalyzer, type Analyzer } from "./analyzer.js";
import { computeFluencyAnalytics, resolvePracticeTargets, selectPracticeAnalysisContext } from "./analytics.js";
import { collectPrompt } from "./collector.js";
import {
  showCoachingOverlay,
  type CoachingCheckResult,
  type CoachingOverlayDecision,
  type CoachingSnoozeDecision,
  type CoachingSnoozeHandler,
} from "./coaching-overlay.js";
import {
  analysisReuseAction,
  analyzerResultFingerprint,
  isCoachingEligible,
  revalidateCoachingPolicy,
  selectedCoachingMistakes,
} from "./coaching.js";
import { showFluencyOverlay, type FluencyView } from "./overlay.js";
import { PracticeSessionSnooze } from "./practice-settings.js";
import { sanitizeTerminalLabel } from "./sanitize.js";
import { runSetup } from "./setup.js";
import { formatStatus, type StatusErrorReason, type StatusState } from "./status.js";
import { FluencyStore, type AnalysisCommitFence } from "./store.js";
import type { FluencySettings, PracticeSettings } from "./types.js";
import { FluencyWorker } from "./worker.js";

const STATUS_KEY = "pi-fluency";
const USAGE = "Usage: /fluency [pause|resume|status|model|clear|stats|practice [on|off|resume|reset]]";
const PRACTICE_DISCLOSURE = "Before main submission, full sanitized draft goes to configured Fluency model and may be analyzed even if you later choose not to send it.";

export interface OpenInboxOptions {
  signal: AbortSignal;
  initialView?: FluencyView;
  onProgressChanged?: () => void;
  onMutationError?: (error: unknown) => void;
}

/** Overlay seam shared by command and shortcut contexts; implementations need only common UI/mode APIs. */
export type OpenInbox = (
  ctx: ExtensionContext,
  store: FluencyStore,
  options: OpenInboxOptions,
) => Promise<void> | void;

export type ShowCoaching = (
  ctx: ExtensionContext,
  check: Promise<CoachingCheckResult>,
  signal?: AbortSignal,
  saveSnooze?: CoachingSnoozeHandler,
) => Promise<CoachingOverlayDecision>;

export interface ExtensionDependencies {
  rootDir?: string;
  analyzerFactory?: (ctx: ExtensionContext, store: FluencyStore, settings?: FluencySettings) => Analyzer;
  now?: () => number;
  openInbox?: OpenInbox;
  showCoaching?: ShowCoaching;
}

interface ResolvedDependencies extends ExtensionDependencies {
  rootDir: string;
  now: () => number;
}

function hasConfiguredIdentity(settings: FluencySettings): boolean {
  return settings.enabled
    && typeof settings.consentedAt === "number"
    && Number.isFinite(settings.consentedAt)
    && settings.consentedAt > 0
    && typeof settings.provider === "string"
    && settings.provider.trim().length > 0
    && typeof settings.modelId === "string"
    && settings.modelId.trim().length > 0;
}

function hasValidConfiguration(settings: FluencySettings, ctx: ExtensionContext): boolean {
  if (!hasConfiguredIdentity(settings)) return false;
  return ctx.modelRegistry.find(settings.provider!, settings.modelId!) !== undefined;
}

function fenceFromPolicy(policy: { settings: FluencySettings; historyGeneration: string }): AnalysisCommitFence {
  const settings = policy.settings;
  return {
    historyGeneration: policy.historyGeneration,
    enabled: settings.enabled,
    minimumConfidence: settings.minimumConfidence,
    ...(settings.consentedAt === undefined ? {} : { consentedAt: settings.consentedAt }),
    ...(settings.provider === undefined ? {} : { provider: settings.provider }),
    ...(settings.modelId === undefined ? {} : { modelId: settings.modelId }),
  };
}

function sameAnalysisFence(left: AnalysisCommitFence, right: AnalysisCommitFence): boolean {
  return left.historyGeneration === right.historyGeneration
    && left.enabled === right.enabled
    && left.consentedAt === right.consentedAt
    && left.provider === right.provider
    && left.modelId === right.modelId
    && left.minimumConfidence === right.minimumConfidence;
}

function registerHandlers(pi: ExtensionAPI, dependencies: ResolvedDependencies): void {
  let storeRef: FluencyStore | undefined;
  let storePromise: Promise<FluencyStore> | undefined;
  let workerRef: FluencyWorker | undefined;
  let ctxRef: ExtensionContext | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let shuttingDown = false;
  let overlayOpen: Promise<void> | undefined;
  let overlayController: AbortController | undefined;
  const notifiedErrors = new Set<string>();
  const inputSessionId = randomUUID();
  let inputSequence = 0;
  const practiceSessionSnooze = new PracticeSessionSnooze();
  const coachingControllers = new Set<AbortController>();
  const scheduledCommits = new Set<Promise<void>>();

  const sessionFile = (ctx: ExtensionContext): string | undefined =>
    ctx.sessionManager?.getSessionFile?.();
  const sessionEntries = (ctx: ExtensionContext) => ctx.sessionManager?.getEntries?.() ?? [];
  const isSessionPracticeSnoozed = (
    ctx: ExtensionContext,
    store: FluencyStore,
    practice: PracticeSettings = store.getPracticeSettings(),
  ): boolean => practiceSessionSnooze.restore(sessionEntries(ctx), sessionFile(ctx), practice.epoch);
  const resumeSessionPractice = (ctx: ExtensionContext, store: FluencyStore): void => {
    const practice = store.getPracticeSettings();
    practiceSessionSnooze.resume(
      sessionFile(ctx),
      practice.epoch,
      (customType, data) => pi.appendEntry(customType, data),
    );
  };

  const publishStatus = (ctx: ExtensionContext, state: StatusState): void => {
    const text = formatStatus(state);
    ctx.ui.setStatus(STATUS_KEY, text);
    if (text === undefined) {
      pi.events.emit("powerbar:update", { id: STATUS_KEY, text: undefined });
      return;
    }
    const separator = text.indexOf(" ");
    const icon = separator < 0 ? text : text.slice(0, separator);
    const powerbarText = separator < 0 ? "" : text.slice(separator + 1);
    const color = state.kind === "initial-loading"
      ? "muted"
      : state.kind === "error"
        ? "error"
        : state.kind === "progress" && state.pendingOccurrences > 0 ? "warning" : "success";
    pi.events.emit("powerbar:update", { id: STATUS_KEY, text: powerbarText, icon, color });
  };
  const clearStatus = (ctx: ExtensionContext): void => publishStatus(ctx, { kind: "hidden" });

  const notifyError = (ctx: ExtensionContext, error: unknown): void => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    const detail = sanitizeTerminalLabel(normalized.message) || "Unknown error";
    if (!notifiedErrors.has(detail)) {
      notifiedErrors.add(detail);
      ctx.ui.notify(`Pi Fluency: ${detail}`, "error");
    }
  };

  const setError = (ctx: ExtensionContext, reason: StatusErrorReason, error: unknown): void => {
    const store = storeRef;
    if (shuttingDown || !store || !store.getSettings().enabled) {
      clearStatus(ctx);
      return;
    }
    publishStatus(ctx, { kind: "error", reason });
    notifyError(ctx, error);
  };

  const publishProgress = (ctx: ExtensionContext, store: FluencyStore): void => {
    const migrationWarning = store.getWarnings().find((warning) => warning.toLowerCase().includes("migration"));
    if (migrationWarning) {
      setError(ctx, "migrate", new Error(migrationWarning));
      return;
    }
    const snapshot = store.getAnalyticsSnapshot();
    const analytics = computeFluencyAnalytics({
      observations: snapshot.observations,
      occurrences: snapshot.occurrences,
      patterns: snapshot.patterns,
      ignoredPatternKeys: new Set(snapshot.ignoredPatternKeys),
      ignoredCategories: new Set(snapshot.ignoredCategories),
      now: dependencies.now(),
    });
    publishStatus(ctx, {
      kind: "progress",
      pendingOccurrences: analytics.pendingOccurrences,
      activeRules: analytics.activeRules,
      sparkline: analytics.toolbarSparkline,
      ratePerThousand: analytics.currentRatePerThousand,
    });
  };

  const getStore = async (): Promise<FluencyStore> => {
    storePromise ??= FluencyStore.open(dependencies.rootDir).then((store) => {
      storeRef = store;
      return store;
    });
    return storePromise;
  };

  const analyzerErrorReason = (error: unknown): StatusErrorReason => {
    if (!(error instanceof AnalyzerConfigurationError)) return "analyze";
    return /auth|api[- ]?key|credential|token/i.test(error.message) ? "auth" : "model";
  };

  const publishConfigurationFailureOrClear = (ctx: ExtensionContext, store: FluencyStore): void => {
    const settings = store.getSettings();
    if (hasConfiguredIdentity(settings)
      && ctx.modelRegistry.find(settings.provider!, settings.modelId!) === undefined) {
      setError(ctx, "model", new AnalyzerConfigurationError("Configured Pi Fluency model is unavailable"));
    } else {
      clearStatus(ctx);
    }
  };

  const createAnalyzer = (
    ctx: ExtensionContext,
    store: FluencyStore,
    settings: FluencySettings = store.getSettings(),
  ): Analyzer => {
    if (dependencies.analyzerFactory) return dependencies.analyzerFactory(ctx, store, settings);
    const model = settings.provider && settings.modelId
      ? ctx.modelRegistry.find(settings.provider, settings.modelId)
      : undefined;
    if (!model) throw new AnalyzerConfigurationError("Configured Pi Fluency model is unavailable");
    return new ModelAnalyzer({
      model,
      registry: ctx.modelRegistry,
      minimumConfidence: settings.minimumConfidence,
    });
  };

  const getWorker = (ctx: ExtensionContext, store: FluencyStore): FluencyWorker => {
    ctxRef = ctx;
    workerRef ??= new FluencyWorker({
      analyzer: createAnalyzer(ctx, store),
      getAnalyzerConfiguration: async (job) => {
        if (job.fence === undefined) return undefined;
        const currentCtx = ctxRef ?? ctx;
        const fresh = await store.getFreshPolicySnapshot(Date.now() + 1_000);
        const freshFence = fenceFromPolicy(fresh);
        if (!sameAnalysisFence(job.fence, freshFence) || !hasConfiguredIdentity(fresh.settings)) return undefined;
        return {
          fingerprint: analyzerResultFingerprint(fresh.settings),
          analyzer: createAnalyzer(currentCtx, store, fresh.settings),
        };
      },
      isIdle: () => ctxRef?.isIdle() ?? false,
      getPatterns: () => store.listKnownPatterns(),
      onResult: async (prompt, result, fence) => {
        if (fence === undefined) return;
        try {
          const committed = await store.conditionalAppendAnalysis(fence, prompt, result);
          if (committed !== "committed") return;
        } catch (error) {
          if (ctxRef) setError(ctxRef, "store", error);
          return;
        }
        const currentCtx = ctxRef;
        if (shuttingDown) return;
        if (currentCtx && hasValidConfiguration(store.getSettings(), currentCtx)) {
          if (shuttingDown) return;
          publishProgress(currentCtx, store);
        } else if (currentCtx) {
          clearStatus(currentCtx);
        }
      },
      onError: (error) => {
        if (!ctxRef) return;
        if (!hasValidConfiguration(store.getSettings(), ctxRef)) {
          publishConfigurationFailureOrClear(ctxRef, store);
        } else {
          setError(ctxRef, analyzerErrorReason(error), error);
        }
      },
      onOverflow: () => undefined,
    });
    return workerRef;
  };

  const openInbox = async (
    ctx: ExtensionContext,
    store: FluencyStore,
    initialView: FluencyView = "inbox",
  ): Promise<void> => {
    if (shuttingDown) return;
    if (overlayOpen) {
      await overlayOpen;
      return;
    }
    const controller = new AbortController();
    overlayController = controller;
    const onProgressChanged = (): void => {
      if (!shuttingDown && hasValidConfiguration(store.getSettings(), ctx)) publishProgress(ctx, store);
    };
    const onMutationError = (error: unknown): void => setError(ctx, "store", error);
    const current = Promise.resolve(
      dependencies.openInbox
        ? dependencies.openInbox(ctx, store, {
          signal: controller.signal,
          initialView,
          onProgressChanged,
          onMutationError,
        })
        : showFluencyOverlay(
          ctx,
          store,
          controller.signal,
          onProgressChanged,
          onMutationError,
          initialView,
          dependencies.now,
          {
            sessionSnoozed: () => isSessionPracticeSnoozed(ctx, store),
            resumeSession: () => resumeSessionPractice(ctx, store),
          },
        ),
    );
    overlayOpen = current;
    try {
      await current;
    } finally {
      if (overlayOpen === current) {
        overlayOpen = undefined;
        overlayController = undefined;
      }
    }
  };

  const selectModel = async (ctx: ExtensionCommandContext, store: FluencyStore): Promise<boolean> => {
    const changed = await runSetup(ctx, store, { enable: false, now: dependencies.now });
    if (!changed) return false;
    await workerRef?.shutdown();
    workerRef = undefined;
    if (hasValidConfiguration(store.getSettings(), ctx)) publishProgress(ctx, store);
    else clearStatus(ctx);
    const settings = store.getSettings();
    const provider = sanitizeTerminalLabel(settings.provider, 100) || "unknown-provider";
    const modelId = sanitizeTerminalLabel(settings.modelId, 100) || "unknown-model";
    ctx.ui.notify(`Pi Fluency model: ${provider}/${modelId}`, "info");
    return true;
  };

  const command = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    if (shuttingDown) return;
    ctxRef = ctx;
    const store = await getStore();
    const action = args.trim();
    if (action === "") {
      if (hasValidConfiguration(store.getSettings(), ctx)) await openInbox(ctx, store);
      else {
        clearStatus(ctx);
        await runSetup(ctx, store, { now: dependencies.now });
        if (hasValidConfiguration(store.getSettings(), ctx)) publishProgress(ctx, store);
        else clearStatus(ctx);
      }
      return;
    }
    if (action === "stats") {
      await openInbox(ctx, store, "stats");
      return;
    }
    if (action === "practice") {
      await openInbox(ctx, store, "stats");
      return;
    }
    if (action === "practice on") {
      const practice = store.getPracticeSettings();
      if (practice.consentedAt === undefined) {
        const confirmed = await ctx.ui.confirm("Enable Pi Fluency practice?", PRACTICE_DISCLOSURE);
        if (!confirmed) {
          ctx.ui.notify("Pi Fluency practice unchanged", "info");
          return;
        }
        await store.activatePractice(dependencies.now());
      } else {
        await store.setPracticeEnabled(true);
      }
      ctx.ui.notify("Pi Fluency practice enabled", "info");
      return;
    }
    if (action === "practice off") {
      await store.setPracticeEnabled(false);
      ctx.ui.notify("Pi Fluency practice disabled", "info");
      return;
    }
    if (action === "practice resume") {
      // Mutation rereads sidecar under global lock, so stale process cache cannot miss durable snooze.
      await store.resumePractice();
      if (isSessionPracticeSnoozed(ctx, store)) resumeSessionPractice(ctx, store);
      ctx.ui.notify("Pi Fluency practice resumed now", "info");
      return;
    }
    if (action === "practice reset") {
      if (await ctx.ui.confirm("Reset Pi Fluency practice?", "This clears practice targets, consent, mode, and snoozes. Fluency history stays unchanged.")) {
        await store.resetPractice();
        ctx.ui.notify("Pi Fluency practice reset", "info");
      }
      return;
    }
    if (action === "pause") {
      await store.updateSettings({ enabled: false });
      await workerRef?.shutdown();
      workerRef = undefined;
      clearStatus(ctx);
      ctx.ui.notify("Pi Fluency paused", "info");
      return;
    }
    if (action === "resume") {
      const settings = store.getSettings();
      const resumedSettings = { ...settings, enabled: true };
      if (!hasValidConfiguration(resumedSettings, ctx)) {
        clearStatus(ctx);
        ctx.ui.notify("Pi Fluency needs consent and an available model. Run /fluency.", "warning");
        return;
      }
      await store.updateSettings({ enabled: true });
      publishProgress(ctx, store);
      ctx.ui.notify("Pi Fluency resumed", "info");
      return;
    }
    if (action === "status") {
      const settings = store.getSettings();
      const snapshot = workerRef?.getSnapshot() ?? { queued: 0, dropped: 0 };
      const sanitize = (value: string | undefined): string | undefined => sanitizeTerminalLabel(value, 100) || undefined;
      const provider = sanitize(settings.provider);
      const modelId = sanitize(settings.modelId);
      const model = provider && modelId ? `${provider}/${modelId}` : "not selected";
      const active = hasValidConfiguration(settings, ctx);
      const state = active
        ? "enabled"
        : settings.enabled ? "inactive (configuration invalid)" : "paused";
      const practice = store.getPracticeSettings();
      const globalSnoozed = (practice.snoozedUntil ?? 0) > dependencies.now();
      const sessionSnoozed = isSessionPracticeSnoozed(ctx, store);
      const practiceSnooze = globalSnoozed && sessionSnoozed
        ? "session+5-hour"
        : sessionSnoozed ? "session" : globalSnoozed ? "5-hour" : "none";
      if (!active) clearStatus(ctx);
      ctx.ui.notify(
        `Pi Fluency: ${state}; model=${model}; queued=${snapshot.queued}; dropped=${snapshot.dropped}; warnings=${store.getWarnings().length}; practice=${practice.enabled ? "on" : "off"}; practice-selected=${practice.targets.length}; practice-snooze=${practiceSnooze}`,
        "info",
      );
      return;
    }
    if (action === "model") {
      await selectModel(ctx, store);
      return;
    }
    if (action === "clear") {
      if (await ctx.ui.confirm("Clear Pi Fluency history?", "This removes all recorded coaching history.")) {
        await workerRef?.shutdown();
        workerRef = undefined;
        await store.clear();
        if (hasValidConfiguration(store.getSettings(), ctx)) publishProgress(ctx, store);
        else clearStatus(ctx);
        ctx.ui.notify("Pi Fluency history cleared", "info");
      }
      return;
    }
    ctx.ui.notify(USAGE, "warning");
  };

  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx;
    publishStatus(ctx, { kind: "initial-loading" });
    try {
      const store = await getStore();
      if (shuttingDown) {
        clearStatus(ctx);
        return;
      }
      if (!hasValidConfiguration(store.getSettings(), ctx)) {
        publishConfigurationFailureOrClear(ctx, store);
        return;
      }
      publishProgress(ctx, store);
    } catch (error) {
      if (shuttingDown) clearStatus(ctx);
      else {
        publishStatus(ctx, { kind: "error", reason: "store" });
        notifyError(ctx, error);
      }
    }
  });

  pi.on("input", async (event, ctx) => {
    const handlerStartedAt = Date.now();
    const foregroundDeadline = handlerStartedAt + 6_000;
    if (shuttingDown || event.source !== "interactive") return;
    ctxRef = ctx;
    const collected = collectPrompt(event.text, dependencies.now());
    if (!collected) return;
    const prompt = {
      ...collected,
      promptHash: createHash("sha256")
        .update(`${collected.promptHash}\0${inputSessionId}\0${inputSequence++}`)
        .digest("hex"),
    };
    const idleTextOnly = ctx.isIdle()
      && event.streamingBehavior === undefined
      && (event.images?.length ?? 0) === 0;

    // Enter may already have emptied Pi's editor. Preserve received bytes before any preflight I/O.
    if (idleTextOnly) {
      try {
        ctx.ui.setEditorText(event.text);
      } catch {
        // Original event still owns submission. Only ordinary background collection may follow.
        try {
          const fallbackStore = await getStore();
          const fresh = await fallbackStore.getFreshPolicySnapshot(foregroundDeadline);
          if (!shuttingDown && hasValidConfiguration(fresh.settings, ctx)) {
            getWorker(ctx, fallbackStore).enqueue(prompt, fenceFromPolicy(fresh));
          }
        } catch { /* Original input remains fail-open. */ }
        return;
      }
    }

    let store: FluencyStore;
    try {
      store = await getStore();
    } catch {
      if (!idleTextOnly) return;
      try {
        ctx.ui.setEditorText("");
        ctx.ui.notify("Sent without practice check — policy unavailable.", "warning");
        return { action: "continue" };
      } catch {
        ctx.ui.notify("Not sent — editor could not be cleared.", "error");
        return { action: "handled" };
      }
    }
    if (shuttingDown) {
      if (idleTextOnly) {
        try { ctx.ui.setEditorText(""); } catch { return { action: "handled" }; }
        return { action: "continue" };
      }
      return;
    }
    const queueBackground = (policy: { settings: FluencySettings; historyGeneration: string }): void => {
      try {
        getWorker(ctx, store).enqueue(prompt, fenceFromPolicy(policy));
      } catch (error) {
        setError(ctx, analyzerErrorReason(error), error);
      }
    };
    let initialPolicy;
    try {
      initialPolicy = await store.getFreshPolicySnapshot(foregroundDeadline);
    } catch {
      if (!idleTextOnly) return;
      try {
        ctx.ui.setEditorText("");
        ctx.ui.notify("Sent without practice check — policy unavailable.", "warning");
        return { action: "continue" };
      } catch {
        ctx.ui.notify("Not sent — editor could not be cleared.", "error");
        return { action: "handled" };
      }
    }
    if (!hasValidConfiguration(initialPolicy.settings, ctx)) {
      publishConfigurationFailureOrClear(ctx, store);
      if (!idleTextOnly) return;
      try { ctx.ui.setEditorText(""); } catch {
        ctx.ui.notify("Not sent — editor could not be cleared.", "error");
        return { action: "handled" };
      }
      return { action: "continue" };
    }
    if (store.hasProcessedPromptHash(prompt.promptHash)) {
      if (!idleTextOnly) return;
      try { ctx.ui.setEditorText(""); } catch { return { action: "handled" }; }
      return { action: "continue" };
    }
    if (!idleTextOnly) {
      queueBackground(initialPolicy);
      return;
    }
    let backgroundAllowed = true;
    let backgroundPolicy = initialPolicy;
    const restoreInputStatus = (): void => {
      if (shuttingDown || !backgroundAllowed) clearStatus(ctx);
      else publishProgress(ctx, store);
    };
    const clearForContinue = (): boolean => {
      try {
        ctx.ui.setEditorText("");
        return true;
      } catch {
        ctx.ui.notify("Not sent — editor could not be cleared.", "error");
        restoreInputStatus();
        return false;
      }
    };
    const failOpen = (message: string): { action: "continue" } | { action: "handled" } => {
      if (backgroundAllowed) queueBackground(backgroundPolicy);
      if (!clearForContinue()) return { action: "handled" };
      ctx.ui.notify(message, "warning");
      restoreInputStatus();
      return { action: "continue" };
    };

    const initialSessionSnoozed = isSessionPracticeSnoozed(ctx, store, initialPolicy.practice);
    const hasActiveTarget = resolvePracticeTargets({
      targets: initialPolicy.practice.targets,
      patterns: store.listKnownPatterns(),
      ignoredPatternKeys: new Set(initialPolicy.settings.ignoredPatternKeys),
      ignoredCategories: new Set(initialPolicy.settings.ignoredCategories),
    }).some((target) => target.coachingEnabled);
    if (!hasValidConfiguration(initialPolicy.settings, ctx)
      || !hasActiveTarget
      || !isCoachingEligible({
        source: event.source,
        idle: true,
        textOnly: true,
        collectionEligible: true,
        sessionSnoozed: initialSessionSnoozed,
        now: dependencies.now(),
        policy: initialPolicy,
      })) {
      if (!clearForContinue()) return { action: "handled" };
      if (hasValidConfiguration(initialPolicy.settings, ctx)) queueBackground(initialPolicy);
      return { action: "continue" };
    }

    const commitFence = fenceFromPolicy(initialPolicy);
    publishStatus(ctx, { kind: "practice-check" });
    const attemptController = new AbortController();
    coachingControllers.add(attemptController);
    let successfulResult: Awaited<ReturnType<Analyzer["analyze"]>> | undefined;
    let checkPolicy = initialPolicy;
    let checkSessionSnoozed = initialSessionSnoozed;
    let analyzerChangeObserved = false;
    let technicalFailureMessage = "Sent without practice check — analyzer busy/timed out/failed.";
    const checkPromise: Promise<CoachingCheckResult> = (async () => {
      try {
        const context = selectPracticeAnalysisContext(initialPolicy.practice.targets, store.listKnownPatterns());
        const outcome = await getWorker(ctx, store).analyzeForeground({
          analyzer: createAnalyzer(ctx, store, initialPolicy.settings),
          prompt,
          patterns: context.patterns,
          selectedTargets: context.targetDescriptors,
          deadline: foregroundDeadline,
          signal: attemptController.signal,
          abortGraceMs: 100,
          authorize: async () => {
            const fresh = await store.getFreshPolicySnapshot(foregroundDeadline, attemptController.signal);
            const sessionSnoozed = isSessionPracticeSnoozed(ctx, store, fresh.practice);
            checkPolicy = fresh;
            checkSessionSnoozed = sessionSnoozed;
            backgroundPolicy = fresh;
            return revalidateCoachingPolicy(
              initialPolicy,
              fresh,
              initialSessionSnoozed,
              sessionSnoozed,
            ) === "unchanged"
              && isCoachingEligible({
                source: event.source,
                idle: true,
                textOnly: true,
                collectionEligible: true,
                sessionSnoozed,
                now: dependencies.now(),
                policy: fresh,
              });
          },
        });
        if (outcome.kind !== "success") {
          if (outcome.kind === "quarantined") {
            technicalFailureMessage = "Sent without practice check — analyzer unavailable; restart Pi to restore practice.";
          }
          return { kind: "failure" };
        }
        successfulResult = outcome.result;
        checkPolicy = await store.getFreshPolicySnapshot(foregroundDeadline, attemptController.signal);
        checkSessionSnoozed = isSessionPracticeSnoozed(ctx, store, checkPolicy.practice);
        backgroundPolicy = checkPolicy;
        const revalidation = revalidateCoachingPolicy(
          initialPolicy,
          checkPolicy,
          initialSessionSnoozed,
          checkSessionSnoozed,
        );
        analyzerChangeObserved = revalidation === "analyzer-changed";
        if (revalidation === "analytics-disabled" || revalidation === "analyzer-changed") {
          if (revalidation === "analytics-disabled") backgroundAllowed = false;
          return { kind: "failure" };
        }
        const gateStillEligible = isCoachingEligible({
          source: event.source,
          idle: true,
          textOnly: true,
          collectionEligible: true,
          sessionSnoozed: checkSessionSnoozed,
          now: dependencies.now(),
          policy: checkPolicy,
        });
        const matches = gateStillEligible
          ? selectedCoachingMistakes(outcome.result, checkPolicy.settings, checkPolicy.practice)
          : [];
        return matches.length === 0
          ? { kind: "clean" }
          : { kind: "matches", mistakes: matches, targets: checkPolicy.practice.targets };
      } catch {
        return { kind: "failure" };
      }
    })();

    let snoozePersisted = false;
    const persistSnooze = async (action: CoachingSnoozeDecision): Promise<void> => {
      snoozePersisted = true;
      if (action === "snooze-session") {
        try {
          practiceSessionSnooze.snooze(
            sessionFile(ctx),
            checkPolicy.practice.epoch,
            (customType, data) => pi.appendEntry(customType, data),
          );
        } catch {
          ctx.ui.notify("Sent once; conversation snooze was not activated.", "warning");
        }
        return;
      }
      const operationDeadline = Date.now() + 1_000;
      const mutation = store.snoozePracticeForFiveHours(
        checkPolicy.practice.revision,
        operationDeadline,
        dependencies.now(),
      ).then((activated) => ({ kind: "result" as const, activated }), () => ({ kind: "error" as const }));
      const first = await Promise.race([
        mutation,
        new Promise<{ kind: "deadline" }>((resolve) => setTimeout(
          () => resolve({ kind: "deadline" }),
          Math.max(0, operationDeadline - Date.now()),
        )),
      ]);
      if (first.kind === "result" && first.activated) return;

      // Mutation and confirmation share one absolute second. Never manufacture a second deadline.
      if (Date.now() < operationDeadline) {
        try {
          const authoritative = await store.getFreshPolicySnapshot(operationDeadline);
          if ((authoritative.practice.snoozedUntil ?? 0) > dependencies.now()) return;
          ctx.ui.notify("Sent once; 5-hour snooze was not activated.", "warning");
          return;
        } catch { /* Remaining deadline could not establish authoritative state. */ }
      }
      ctx.ui.notify("Sent once; snooze state unknown — use /fluency practice resume.", "warning");
    };

    let decision: CoachingOverlayDecision;
    try {
      decision = await (dependencies.showCoaching ?? showCoachingOverlay)(
        ctx,
        checkPromise,
        attemptController.signal,
        persistSnooze,
      );
    } catch {
      decision = "technical-failure";
    }
    if (decision === "edit") {
      attemptController.abort();
      await checkPromise;
      coachingControllers.delete(attemptController);
      ctx.ui.notify("Not sent — draft remains in editor.", "info");
      restoreInputStatus();
      return { action: "handled" };
    }
    if (decision === "send-unchecked" || decision === "technical-failure") {
      attemptController.abort();
      await checkPromise;
      coachingControllers.delete(attemptController);
      return failOpen(decision === "send-unchecked"
        ? "Sent without practice check — analyzer cancelled."
        : technicalFailureMessage);
    }
    coachingControllers.delete(attemptController);

    if ((decision === "snooze-session" || decision === "snooze-five-hours") && !snoozePersisted) {
      await persistSnooze(decision);
    }

    if (!clearForContinue()) return { action: "handled" };

    if (successfulResult !== undefined) {
      let finalPolicy = checkPolicy;
      let finalSessionSnoozed = checkSessionSnoozed;
      try {
        finalPolicy = await store.getFreshPolicySnapshot(Date.now() + 1_000);
        finalSessionSnoozed = isSessionPracticeSnoozed(ctx, store, finalPolicy.practice);
        backgroundPolicy = finalPolicy;
      } catch { /* Conditional store fence remains authoritative. */ }
      const revalidation = revalidateCoachingPolicy(
        initialPolicy,
        finalPolicy,
        initialSessionSnoozed,
        finalSessionSnoozed,
      );
      const reuse = analysisReuseAction("continue", revalidation);
      if (reuse === "commit-foreground") {
        let tracked!: Promise<void>;
        tracked = store.conditionalAppendAnalysis(commitFence, prompt, successfulResult)
          .then((result) => {
            if (result === "analyzer-stale" && !shuttingDown) queueBackground(backgroundPolicy);
            else if (result === "committed" && !shuttingDown) publishProgress(ctx, store);
          })
          .catch((error) => {
            if (!shuttingDown) setError(ctx, "store", error);
          })
          .finally(() => scheduledCommits.delete(tracked));
        scheduledCommits.add(tracked);
      } else if (reuse === "queue-background" || analyzerChangeObserved) {
        queueBackground(backgroundPolicy);
      }
    } else {
      queueBackground(backgroundPolicy);
    }
    restoreInputStatus();
    return { action: "continue" };
  });

  pi.on("agent_settled", (_event, ctx) => {
    ctxRef = ctx;
    const store = storeRef;
    if (shuttingDown || !store) {
      clearStatus(ctx);
      return;
    }
    if (!hasValidConfiguration(store.getSettings(), ctx)) {
      publishConfigurationFailureOrClear(ctx, store);
      return;
    }
    try {
      void getWorker(ctx, store).drain().catch((error) => setError(ctx, analyzerErrorReason(error), error));
    } catch (error) {
      setError(ctx, analyzerErrorReason(error), error);
    }
  });

  pi.on("session_shutdown", () => {
    shutdownPromise ??= (async () => {
      shuttingDown = true;
      const shutdownCtx = ctxRef;
      if (shutdownCtx) clearStatus(shutdownCtx);
      overlayController?.abort();
      for (const controller of coachingControllers) controller.abort();
      const commits = Promise.allSettled([...scheduledCommits]);
      await Promise.all([
        workerRef?.shutdown(),
        overlayOpen,
        Promise.race([commits, new Promise<void>((resolve) => setTimeout(resolve, 100))]),
      ]);
      coachingControllers.clear();
      if (shutdownCtx) clearStatus(shutdownCtx);
      workerRef = undefined;
      overlayOpen = undefined;
      overlayController = undefined;
      ctxRef = undefined;
    })();
    return shutdownPromise;
  });

  pi.registerCommand("fluency", {
    description: "Configure Pi Fluency and open coaching inbox",
    handler: command,
  });

  pi.registerShortcut(Key.ctrlShift("l"), {
    description: "Open Pi Fluency inbox",
    handler: async (ctx) => {
      if (shuttingDown) return;
      ctxRef = ctx;
      const store = await getStore();
      if (hasValidConfiguration(store.getSettings(), ctx)) await openInbox(ctx, store);
      else {
        clearStatus(ctx);
        ctx.ui.notify("Run /fluency to enable Pi Fluency", "info");
      }
    },
  });
}

export function createFluencyExtension(dependencies: ExtensionDependencies = {}) {
  return function register(pi: ExtensionAPI): void {
    const rootDir = dependencies.rootDir ?? join(homedir(), ".pi", "agent", "pi-fluency");
    const now = dependencies.now ?? Date.now;
    registerHandlers(pi, { ...dependencies, rootDir, now });
    pi.events.emit("powerbar:register-segment", { id: STATUS_KEY, label: "Pi Fluency" });
  };
}

export default createFluencyExtension();
