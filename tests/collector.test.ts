import { describe, expect, it } from "vitest";
import { collectPrompt } from "../extensions/pi-fluency/collector.js";

describe("collectPrompt", () => {
  it("keeps prose while removing fenced and inline code", () => {
    const result = collectPrompt(
      "Please fix this sentence. `const token = secret`\n```ts\napiKey = 'abc'\n```",
      123,
    );
    expect(result?.prose).toBe("Please fix this sentence.");
    expect(result?.promptHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each(["/fluency", "   ", "```ts\nconst x = 1\n```", "ok"])(
    "skips ineligible input %j",
    (text) => expect(collectPrompt(text, 123)).toBeUndefined(),
  );

  it("removes tilde-fenced code", () => {
    const result = collectPrompt("Keep this prose.\n~~~js\nconst leaked = true;\n~~~\nMore prose here.", 123);
    expect(result?.prose).toBe("Keep this prose. More prose here.");
  });

  it("removes indented code blocks", () => {
    const result = collectPrompt("Keep this prose.\n    const leaked = true;\n\treturn leaked;\nMore prose here.", 123);
    expect(result?.prose).toBe("Keep this prose. More prose here.");
  });

  it("removes multi-backtick inline code spans", () => {
    const result = collectPrompt("Keep this prose ``const value = `secret` `` and this ending.", 123);
    expect(result?.prose).toBe("Keep this prose and this ending.");
  });

  it.each([
    "Keep this prose.\n```ts\nconst leaked = true;",
    "Keep this prose.\n~~~~\nconst leaked = true;",
  ])("drops everything after an unclosed fence %j", (text) => {
    expect(collectPrompt(text, 123)?.prose).toBe("Keep this prose.");
  });

  it("redacts likely secrets", () => {
    const result = collectPrompt("Please inspect token sk-abcdefghijklmnopqrstuvwxyz123456", 123);
    expect(result?.prose).toBe("Please inspect [REDACTED]");
  });

  it.each([
    "Authorization: Bearer ultra-secret-credential",
    "Bearer ultra-secret-credential",
    "token ghp_abcdefghijklmnopqrstuvwxyz1234567890",
    "github_pat_11AA22BB33CC44DD55EE66FF77",
    "AWS key AKIAIOSFODNN7EXAMPLE",
    "JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturevalue",
    "api key secret-value-here",
  ])("redacts credential form %j before hashing", (secret) => {
    const result = collectPrompt(`Please inspect credentials ${secret} in this prose.`, 123);
    expect(result?.prose).not.toContain(secret.split(" ").at(-1));
    expect(result?.prose).toContain("[REDACTED]");
  });

  it("redacts JWTs with short Base64URL payload and signature segments", () => {
    const result = collectPrompt("Please inspect JWT eyJhbGciOiJIUzI1NiJ9.e30.abc without exposing it.", 123);
    expect(result?.prose).toBe("Please inspect JWT [REDACTED] without exposing it.");
  });

  it("keeps ordinary dotted prose", () => {
    const result = collectPrompt("Please visit documentation.example.com for more details.", 123);
    expect(result?.prose).toBe("Please visit documentation.example.com for more details.");
  });

  it("hashes redacted JWT prose without retaining token differences", () => {
    const left = collectPrompt("Please inspect JWT eyJhbGciOiJIUzI1NiJ9.e30.abc safely.", 123);
    const right = collectPrompt("Please inspect JWT eyJhbGciOiJIUzI1NiJ9.e31.xyz safely.", 123);
    expect(left?.prose).toBe("Please inspect JWT [REDACTED] safely.");
    expect(right).toMatchObject({ prose: left?.prose, promptHash: left?.promptHash });
  });

  it.each([
    "OPENAI_API_KEY=supersecretvalue123",
    "client_secret=supersecretvalue123",
    "password=supersecretvalue123",
    "https://alice:supersecretvalue123@example.com/private",
    "Authorization: Basic c3VwZXJzZWNyZXR2YWx1ZTEyMw==",
    "AWS_SECRET_ACCESS_KEY=supersecretvalue123",
    "DATABASE_URL=postgres://alice:supersecretvalue123@db.example/private",
  ])("redacts broader credential form %j", (secret) => {
    const result = collectPrompt(`Please inspect ${secret} without exposing credentials.`, 123);
    expect(result?.prose).toContain("[REDACTED]");
    expect(result?.prose).not.toContain("supersecretvalue123");
  });

  it("strips terminal control sequences before redaction, hashing, and analysis", () => {
    const dirty = collectPrompt("Please\u001b[31m inspect\u001b[0m this\u0000 prompt\u009b32m\u001b]52;c;secret\u0007 safely.", 123);
    const clean = collectPrompt("Please inspect this prompt safely.", 123);
    expect(dirty).toEqual(clean);
  });

  it.each([
    "Пожалуйста проверьте этот русский текст.",
    "请检查这段中文提示文本。",
    "Por favor revisa este texto español.",
  ])("collects non-Latin prose so analyzer owns language classification: %j", (text) => {
    expect(collectPrompt(text, 123)?.prose).toBe(text);
  });

  it("redacts private key blocks outside fenced code", () => {
    const secret = "-----BEGIN PRIVATE KEY-----\nabcDEF123+/=\n-----END PRIVATE KEY-----";
    const result = collectPrompt(`Please inspect this credential.\n${secret}\nDo not expose it.`, 123);
    expect(result?.prose).toBe("Please inspect this credential. [REDACTED] Do not expose it.");
  });

  it("produces identical prose and hash when only redacted secret differs", () => {
    const left = collectPrompt("Please inspect token ghp_abcdefghijklmnopqrstuvwxyz1234567890 safely.", 123);
    const right = collectPrompt("Please inspect token ghp_0987654321zyxwvutsrqponmlkjihgfedcba safely.", 123);
    expect(left?.prose).toBe("Please inspect [REDACTED] safely.");
    expect(right).toMatchObject({ prose: left?.prose, promptHash: left?.promptHash });
  });
});
