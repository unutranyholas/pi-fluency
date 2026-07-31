import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { vi, type MockedFunction } from "vitest";
import type { Analyzer } from "../../extensions/pi-fluency/analyzer.js";
import {
  DEFAULT_SETTINGS,
  type AnalysisResult,
  type CollectedPrompt,
  type MistakePattern,
} from "../../extensions/pi-fluency/types.js";

export const oneMistake: AnalysisResult = {
  schemaVersion: 3,
  language: "en",
  mistakes: [{
    original: "an mistake",
    correction: "a mistake",
    contextScope: "sentence",
    sourceExcerpt: "I made an mistake.",
    correctedExcerpt: "I made a mistake.",
    explanation: "Use a before a consonant sound.",
    errorType: "R:DET",
    patternKey: "grammar.articles.a-before-consonant",
    confidence: 0.99,
  }],
  demonstratedFixes: [],
};

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type CommandHandler = (args: string, ctx: ExtensionCommandContext) => unknown;
type ShortcutHandler = (ctx: ExtensionContext) => unknown;

export class FakeExtensionApi {
  readonly handlers = new Map<string, Handler[]>();
  readonly commands = new Map<string, CommandHandler>();
  readonly shortcuts = new Map<string, ShortcutHandler>();
  readonly eventEmissions: Array<{ channel: string; data: unknown }> = [];
  readonly events = {
    emit: (channel: string, data: unknown): void => { this.eventEmissions.push({ channel, data }); },
    on: () => (): void => undefined,
  };

  on(event: string, handler: Handler): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  registerCommand(name: string, options: { handler: CommandHandler }): void {
    this.commands.set(name, options.handler);
  }

  registerShortcut(shortcut: string, options: { handler: ShortcutHandler }): void {
    this.shortcuts.set(shortcut, options.handler);
  }

  asExtensionApi(): FakeExtensionApi & ExtensionAPI {
    return this as unknown as FakeExtensionApi & ExtensionAPI;
  }

  async emit(event: string, value: unknown, ctx: ExtensionContext): Promise<unknown> {
    let result: unknown;
    for (const handler of this.handlers.get(event) ?? []) {
      const current = await handler(value, ctx);
      if (current !== undefined) result = current;
    }
    return result;
  }
}

export interface ExtensionHarness {
  pi: FakeExtensionApi & ExtensionAPI;
  fakePi: FakeExtensionApi;
  deps: { rootDir: string; analyzerFactory: () => Analyzer; now: () => number };
  analyzer: { analyze: MockedFunction<Analyzer["analyze"]> };
  statuses: Map<string, string>;
  notifications: Array<{ message: string; type?: string }>;
  select: MockedFunction<ExtensionContext["ui"]["select"]>;
  confirm: MockedFunction<ExtensionContext["ui"]["confirm"]>;
  custom: MockedFunction<ExtensionContext["ui"]["custom"]>;
  editorWrites: string[];
  sessionEntries: Array<{ type: "custom"; customType: string; data: unknown }>;
  get editorText(): string;
  get abortObserved(): boolean;
  get cleanupFinished(): boolean;
  finishAbortCleanup(): void;
  rejectAnalysis(error?: Error): void;
  removeModel(): void;
  emitSessionStart(): Promise<void>;
  emitInput(text: string, source?: "interactive" | "rpc" | "extension", options?: { images?: unknown[]; streamingBehavior?: "steer" | "followUp" }): Promise<unknown>;
  emitMessageEnd(message: unknown): Promise<void>;
  emitAgentSettled(): Promise<void>;
  emitSessionShutdown(reason: "quit" | "reload" | "new" | "resume" | "fork"): Promise<void>;
  runCommand(args?: string): Promise<void>;
  runShortcut(shortcut?: string): Promise<void>;
  waitForResult(): Promise<void>;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

export function userMessage(text: string): unknown {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

export function assistantMessage(text: string): unknown {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "google-generative-ai",
    provider: "google",
    model: "gemini-2.5-flash",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 1,
  };
}

export async function createExtensionHarness(options: {
  enabled: boolean;
  analyzerMode?: "resolve" | "wait-for-abort" | "wait-for-abort-cleanup" | "wait-for-error";
  analysisResult?: AnalysisResult;
  editorFailure?: "preserve" | "clear";
  rootDir?: string;
  sessionEntries?: Array<{ type: "custom"; customType: string; data: unknown }>;
}): Promise<ExtensionHarness> {
  const rootDir = options.rootDir ?? await mkdtemp(join(tmpdir(), "pi-fluency-extension-"));
  if (options.enabled) {
    await writeFile(join(rootDir, "settings.json"), JSON.stringify({
      ...DEFAULT_SETTINGS,
      enabled: true,
      consentedAt: 1,
      provider: "google",
      modelId: "gemini-2.5-flash",
    }));
  }

  const resultDone = deferred();
  const abortCleanup = deferred();
  let rejectAnalysis!: (reason?: unknown) => void;
  const delayedFailure = new Promise<AnalysisResult>((_resolve, reject) => { rejectAnalysis = reject; });
  let abortObserved = false;
  let cleanupFinished = false;
  const analyzeImpl: Analyzer["analyze"] = (
    _prompt: CollectedPrompt,
    _patterns: MistakePattern[],
    signal: AbortSignal,
  ) => {
      if (options.analyzerMode === "wait-for-error") return delayedFailure;
      if (options.analyzerMode !== "wait-for-abort" && options.analyzerMode !== "wait-for-abort-cleanup") {
        return Promise.resolve(options.analysisResult ?? oneMistake);
      }
      return new Promise<AnalysisResult>((_resolve, reject) => {
        const abort = () => {
          abortObserved = true;
          if (options.analyzerMode === "wait-for-abort-cleanup") {
            void abortCleanup.promise.then(() => {
              cleanupFinished = true;
              reject(new DOMException("Aborted", "AbortError"));
            });
          } else {
            cleanupFinished = true;
            reject(new DOMException("Aborted", "AbortError"));
          }
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
  };
  const analyzer = { analyze: vi.fn(analyzeImpl) };

  const model: Model<Api> = {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    provider: "google",
    api: "google-generative-ai",
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 8192,
  };
  const statuses = new Map<string, string>();
  const notifications: Array<{ message: string; type?: string }> = [];
  const selectImpl: ExtensionContext["ui"]["select"] = async () => "google/gemini-2.5-flash";
  const confirmImpl: ExtensionContext["ui"]["confirm"] = async () => true;
  const customImpl: ExtensionContext["ui"]["custom"] = async () => undefined as never;
  const select = vi.fn(selectImpl);
  const confirm = vi.fn(confirmImpl);
  const custom = vi.fn(customImpl);
  let editorText = "";
  const editorWrites: string[] = [];
  const ui = {
    select,
    confirm,
    custom,
    setEditorText: (text: string) => {
      if ((options.editorFailure === "preserve" && text !== "")
        || (options.editorFailure === "clear" && text === "")) throw new Error("editor write failed");
      editorText = text;
      editorWrites.push(text);
    },
    notify: (message: string, type?: string) => notifications.push(type === undefined ? { message } : { message, type }),
    setStatus: (key: string, value: string | undefined) => {
      if (value === undefined) statuses.delete(key);
      else {
        statuses.set(key, value);
        if (!value.includes("󰇰 …")) resultDone.resolve();
      }
    },
  };
  let modelAvailable = true;
  const registry = {
    getAvailable: () => modelAvailable ? [model] : [],
    find: (provider: string, id: string) => modelAvailable && provider === model.provider && id === model.id ? model : undefined,
    getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "fake-key" }),
  };
  const sessionEntries = options.sessionEntries ?? [];
  const ctx = {
    ui,
    modelRegistry: registry,
    sessionManager: {
      getSessionFile: () => join(rootDir, "session.jsonl"),
      getEntries: () => sessionEntries,
    },
    mode: "tui",
    hasUI: true,
    cwd: rootDir,
    model,
    isIdle: () => true,
  } as unknown as ExtensionCommandContext;
  const fakePi = new FakeExtensionApi();
  (fakePi as unknown as { appendEntry: (customType: string, data: unknown) => void }).appendEntry = (customType, data) => {
    sessionEntries.push({ type: "custom", customType, data });
  };

  const emitSessionStart = async (): Promise<void> => {
    await fakePi.emit("session_start", { type: "session_start" }, ctx);
  };
  const emitInput = (
    text: string,
    source: "interactive" | "rpc" | "extension" = "interactive",
    options: { images?: unknown[]; streamingBehavior?: "steer" | "followUp" } = {},
  ) => fakePi.emit("input", {
    type: "input",
    text,
    images: options.images ?? [],
    source,
    streamingBehavior: options.streamingBehavior,
  }, ctx);
  const emitMessageEnd = async (message: unknown): Promise<void> => {
    await fakePi.emit("message_end", { type: "message_end", message }, ctx);
  };
  const emitAgentSettled = async (): Promise<void> => {
    await fakePi.emit("agent_settled", { type: "agent_settled" }, ctx);
  };
  const emitSessionShutdown = async (reason: "quit" | "reload" | "new" | "resume" | "fork"): Promise<void> => {
    await fakePi.emit("session_shutdown", { type: "session_shutdown", reason }, ctx);
  };
  const runCommand = async (args = ""): Promise<void> => {
    const handler = fakePi.commands.get("fluency");
    if (!handler) throw new Error("fluency command not registered");
    await handler(args, ctx);
  };
  const runShortcut = async (shortcut = "ctrl+shift+l"): Promise<void> => {
    const handler = fakePi.shortcuts.get(shortcut);
    if (!handler) throw new Error(`${shortcut} shortcut not registered`);
    await handler(ctx);
  };

  return {
    pi: fakePi.asExtensionApi(),
    fakePi,
    deps: { rootDir, analyzerFactory: () => analyzer, now: () => 123 },
    analyzer,
    statuses,
    notifications,
    select,
    confirm,
    custom,
    editorWrites,
    sessionEntries,
    get editorText() { return editorText; },
    get abortObserved() { return abortObserved; },
    get cleanupFinished() { return cleanupFinished; },
    finishAbortCleanup: abortCleanup.resolve,
    rejectAnalysis: (error = new Error("delayed analyzer failure")) => rejectAnalysis(error),
    removeModel: () => { modelAvailable = false; },
    emitSessionStart,
    emitInput,
    emitMessageEnd,
    emitAgentSettled,
    emitSessionShutdown,
    runCommand,
    runShortcut,
    waitForResult: () => resultDone.promise,
  };
}
