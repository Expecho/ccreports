// Estimates the tokens each tool call and skill load is responsible for.
//
// The transcripts only record usage per API request, so this reconstructs it:
//   - the tool input the model wrote is part of the request's output tokens;
//   - the tool result is added to the context of the next request. Within a
//     tool loop the context of request k+1 is the context of request k plus its
//     output plus the tool results, so the results' size in tokens is measured
//     as ctx(k+1) - ctx(k) - output(k), split over parallel calls by length;
//   - from then on, input and result are re-sent with every later request of
//     that conversation (as cache reads) until it ends or is compacted.
// Where a turn can't be measured (a human message or compaction in between, or
// a skill typed as a command) the size is estimated from the text length, at a
// characters-per-token ratio calibrated on the measured turns.

const DEFAULT_CHARS_PER_TOKEN = 2.4;
// Small results are dominated by per-turn overhead (reminders), so they don't
// feed the calibration.
const MIN_CALIBRATION_CHARS = 2000;

export function createCalibration() {
  return { chars: 0, tokens: 0 };
}

export function charsPerToken(calibration) {
  return calibration.tokens > 0 ? calibration.chars / calibration.tokens : DEFAULT_CHARS_PER_TOKEN;
}

/** Collects the request sequence of one transcript file. */
export class FileAttribution {
  constructor(calibration) {
    this.calibration = calibration;
    this.responses = [];
    this.byKey = new Map();
    this.items = [];
  }

  /** An API response (called for every line of it; the last line wins). */
  response(key, { context, output, model, cache1hShare }) {
    let r = this.byKey.get(key);
    if (!r) {
      r = { tools: [], content: [], human: false, compactAfter: false };
      this.byKey.set(key, r);
      this.responses.push(r);
    }
    Object.assign(r, { context, output, model, cache1hShare });
    return r;
  }

  toolUse(key, id, inputChars, isSkill = false) {
    const r = this.byKey.get(key);
    if (!r || r.tools.some((t) => t.id === id)) return;
    const item = { id, inputChars, isSkill, resultChars: 0, measuredTokens: null, enterAt: this.responses.indexOf(r) + 1 };
    r.tools.push(item);
    this.items.push(item);
  }

  get last() {
    return this.responses[this.responses.length - 1];
  }

  toolResult(toolId, chars) {
    this.last?.content.push({ toolId, chars });
  }

  /** Skill content: after a Skill tool call it belongs to that call; after a typed command, `id` names the skill record. */
  skillContent(chars, id = null) {
    if (id) {
      this.items.push({ id, inputChars: 0, resultChars: chars, measuredTokens: null, enterAt: this.responses.length });
    } else {
      this.last?.content.push({ toolId: 'skill', chars });
    }
  }

  human() {
    if (this.last) this.last.human = true;
  }

  compact() {
    if (this.last) this.last.compactAfter = true;
  }

  /** Measures what can be measured; sizes are turned into tokens later by resolveTokens(). */
  finish() {
    const rs = this.responses;
    const n = rs.length;
    // segEnd[k]: last request that still has request k's context (before compaction or the end).
    const segEnd = new Array(n);
    for (let k = n - 1; k >= 0; k--) segEnd[k] = rs[k].compactAfter || k === n - 1 ? k : segEnd[k + 1];

    for (let k = 0; k < n; k++) {
      const r = rs[k];
      if (!r.tools.length) continue;
      for (const { toolId, chars } of r.content) {
        const target = toolId === 'skill' ? r.tools.find((t) => t.isSkill) ?? r.tools[0] : r.tools.find((t) => t.id === toolId);
        if (target) target.resultChars += chars;
      }
      if (r.compactAfter) {
        // Compacted right after this request: its results never stay in context.
        for (const t of r.tools) t.enterAt = n;
        continue;
      }
      const next = rs[k + 1];
      if (!next || r.human) continue;
      // NaN when a request's context is unknown (Copilot logs without per-request usage).
      const delta = next.context - r.context - r.output;
      if (!(delta > 0)) continue;
      const weight = r.tools.reduce((s, t) => s + t.resultChars, 0);
      for (const t of r.tools) {
        t.measuredTokens = weight > 0 ? (delta * t.resultChars) / weight : delta / r.tools.length;
      }
      if (weight >= MIN_CALIBRATION_CHARS) {
        this.calibration.chars += weight;
        this.calibration.tokens += delta;
      }
    }

    for (const item of this.items) {
      const at = item.enterAt;
      item.carried = at < n ? segEnd[at] - at + 1 : 0; // requests that include it
      const next = rs[at];
      item.model = next?.model ?? this.last?.model;
      item.cache1hShare = next?.cache1hShare ?? 0;
      item.promptTokens = next?.context || 0;
    }
    return this.items;
  }
}

/**
 * Turns measured/estimated sizes into token usage per item:
 *   outputTokens     - the tool input the model wrote
 *   cacheWriteTokens - input + result entering the context
 *   cacheReadTokens  - input + result re-sent with each later request
 */
export function resolveTokens(items, ratio) {
  for (const item of items) {
    const inputTokens = Math.round(item.inputChars / ratio);
    const resultTokens = Math.round(item.measuredTokens ?? item.resultChars / ratio);
    const inContext = inputTokens + resultTokens;
    item.tokens = {
      outputTokens: inputTokens,
      cacheWriteTokens: item.carried > 0 ? inContext : 0,
      cacheReadTokens: inContext * Math.max(item.carried - 1, 0),
      measured: item.measuredTokens != null,
      model: item.model,
      cache1hShare: item.cache1hShare,
      promptTokens: item.promptTokens,
    };
    item.tokens.total = item.tokens.outputTokens + item.tokens.cacheWriteTokens + item.tokens.cacheReadTokens;
  }
}
