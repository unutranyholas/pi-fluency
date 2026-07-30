import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Analyzer } from "../../extensions/pi-fluency/analyzer.js";
import { createFluencyExtension } from "../../extensions/pi-fluency/index.js";

const fakeAnalyzer: Analyzer = {
  async analyze(prompt) {
    return prompt.prose.toLowerCase().includes("an mistake") ? {
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
    } : { schemaVersion: 3, language: "en", mistakes: [], demonstratedFixes: [] };
  },
};

export default function fakeFluency(pi: ExtensionAPI): void {
  createFluencyExtension({
    analyzerFactory: () => fakeAnalyzer,
    rootDir: join(tmpdir(), `pi-fluency-manual-${process.pid}`),
  })(pi);
}
