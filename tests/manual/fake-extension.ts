import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Analyzer } from "../../extensions/pi-fluency/analyzer.js";
import { createFluencyExtension } from "../../extensions/pi-fluency/index.js";

/**
 * Manual U6 harness. All extension-owned data stays below OS temp directory.
 *
 * Start:
 *   PI_FLUENCY_MANUAL_RUN=u6 pi --no-extensions -e ./tests/manual/fake-extension.ts
 *
 * Setup, then send two distinct prompts containing "an mistake" and accept both
 * occurrences. Open `/fluency stats`, press `p`, and select displayed rule.
 * Exercise clean send, Edit/Esc, Send once, both snoozes, and
 * `/fluency practice resume`. Resize terminal while Practice targets and match
 * overlays are open. A prompt containing both "an mistake" and
 * "fluency manual timeout" simulates abort-ignoring adapter; later prompts fail
 * open until process restart. Reuse PI_FLUENCY_MANUAL_RUN across restart to keep
 * temp-only practice state. "fluency manual error" simulates provider failure.
 */

const fakeAnalyzer: Analyzer = {
  async analyze(prompt) {
    const prose = prompt.prose.toLowerCase();
    if (prose.includes("fluency manual timeout")) {
      return await new Promise<never>(() => undefined);
    }
    if (prose.includes("fluency manual error")) {
      throw new Error("Manual analyzer failure");
    }
    if (!prose.includes("an mistake")) {
      return { schemaVersion: 3, language: "en", mistakes: [], demonstratedFixes: [] };
    }
    return {
      schemaVersion: 3,
      language: "en",
      mistakes: [{
        original: "an mistake",
        correction: "a mistake",
        contextScope: "sentence",
        sourceExcerpt: prompt.prose,
        correctedExcerpt: prompt.prose.replace(/an mistake/iu, "a mistake"),
        explanation: "Use a before a consonant sound.",
        errorType: "R:DET",
        patternKey: "grammar.articles.a-before-consonant",
        confidence: 0.99,
      }],
      demonstratedFixes: [],
    };
  },
};

function manualRunId(): string {
  const requested = process.env.PI_FLUENCY_MANUAL_RUN;
  const safe = requested?.replace(/[^a-zA-Z0-9_-]/gu, "").slice(0, 60);
  return safe || String(process.pid);
}

export default function fakeFluency(pi: ExtensionAPI): void {
  createFluencyExtension({
    analyzerFactory: () => fakeAnalyzer,
    rootDir: join(tmpdir(), `pi-fluency-manual-${manualRunId()}`),
  })(pi);
}
