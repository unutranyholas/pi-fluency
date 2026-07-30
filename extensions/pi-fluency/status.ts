export type StatusErrorReason = "auth" | "model" | "analyze" | "store" | "migrate";

export type StatusState =
  | {
    kind: "progress";
    pendingOccurrences: number;
    activeRules: number;
    sparkline: string;
    ratePerThousand: number | undefined;
  }
  | { kind: "initial-loading" }
  | { kind: "error"; reason: StatusErrorReason }
  | { kind: "hidden" };

const VALID_SPARKLINE = /^[·▁▂▃▄▅▆▇█]{7}$/u;
const EMPTY_SPARKLINE = "·······";

const whole = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;

const rate = (value: number | undefined): string =>
  value === undefined || !Number.isFinite(value) || value < 0 ? "—/k" : `${value.toFixed(1)}/k`;

export function formatStatus(state: StatusState): string | undefined {
  switch (state.kind) {
    case "progress": {
      const pending = whole(state.pendingOccurrences);
      const active = whole(state.activeRules);
      const sparkline = VALID_SPARKLINE.test(state.sparkline) ? state.sparkline : EMPTY_SPARKLINE;
      return `${pending > 0 ? "󰇮" : "󰇰"} ${pending}  󰌵 ${active}  ${sparkline} ${rate(state.ratePerThousand)}`;
    }
    case "initial-loading":
      return `󰇰 …  󰌵 …  ${EMPTY_SPARKLINE} —/k`;
    case "error":
      return `󰅙 ERR ${state.reason}`;
    case "hidden":
      return undefined;
  }
}
