import { createHash } from "node:crypto";
import { sanitizeCollectedInput } from "./sanitize.js";
import type { CollectedPrompt } from "./types.js";

const SECRET_PATTERNS = [
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/gi,
  /\bAuthorization\s*:\s*(?:Bearer|Basic)\s+[^\s,;]+/gi,
  /\bBearer\s+[^\s,;]+/gi,
  /\bgithub_pat_[A-Za-z0-9_]{8,}\b/g,
  /\bgh[opusr]_[A-Za-z0-9_]{8,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![A-Za-z0-9_-])/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^@\s/]+@/gi,
  /\b(?:api\s*[_-]?\s*key|token|secret|password|client[_-]?secret|database[_-]?url|[A-Z][A-Z0-9_]*(?:API[_-]?KEY|ACCESS[_-]?KEY|SECRET[_-]?KEY|TOKEN|SECRET|PASSWORD))\s*(?::|=|\s)\s*[^\s,;]+/gi,
];

function stripBlockCode(text: string): string {
  const proseLines: string[] = [];
  let fence: { marker: "`" | "~"; length: number } | undefined;

  for (const line of text.split("\n")) {
    const withoutCarriageReturn = line.replace(/\r$/, "");

    if (fence) {
      const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(withoutCarriageReturn);
      if (closing?.[1]?.startsWith(fence.marker) && closing[1].length >= fence.length) {
        fence = undefined;
      }
      continue;
    }

    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(withoutCarriageReturn);
    if (opening?.[1]) {
      fence = {
        marker: opening[1][0] as "`" | "~",
        length: opening[1].length,
      };
      continue;
    }

    if (/^(?: {4,}|\t)/.test(withoutCarriageReturn)) continue;
    proseLines.push(line);
  }

  return proseLines.join("\n");
}

function stripInlineCode(text: string): string {
  let prose = "";
  let index = 0;

  while (index < text.length) {
    if (text[index] !== "`") {
      prose += text[index];
      index += 1;
      continue;
    }

    let openerEnd = index;
    while (text[openerEnd] === "`") openerEnd += 1;
    const delimiterLength = openerEnd - index;
    let searchIndex = openerEnd;
    let closingEnd: number | undefined;

    while (searchIndex < text.length) {
      if (text[searchIndex] !== "`") {
        searchIndex += 1;
        continue;
      }

      let candidateEnd = searchIndex;
      while (text[candidateEnd] === "`") candidateEnd += 1;
      if (candidateEnd - searchIndex === delimiterLength) {
        closingEnd = candidateEnd;
        break;
      }
      searchIndex = candidateEnd;
    }

    prose += " ";
    if (closingEnd === undefined) break;
    index = closingEnd;
  }

  return prose;
}

export function collectPrompt(text: string, observedAt = Date.now()): CollectedPrompt | undefined {
  const sanitized = sanitizeCollectedInput(text);
  if (sanitized.trimStart().startsWith("/")) return undefined;

  let prose = stripInlineCode(stripBlockCode(sanitized));
  for (const pattern of SECRET_PATTERNS) prose = prose.replace(pattern, "[REDACTED]");
  prose = prose.replace(/\s+/g, " ").trim();
  if (prose.length < 8 || (prose.match(/\p{L}/gu)?.length ?? 0) < 3) return undefined;

  return {
    prose,
    observedAt,
    promptHash: createHash("sha256").update(prose).digest("hex"),
  };
}
