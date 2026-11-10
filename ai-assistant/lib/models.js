// Claude models offered in the panel, and which of them take an effort level.

export const CLAUDE_API_MODELS = [
  { id: "claude-opus-5-5", name: "Opus 5.5" },
  { id: "claude-sonnet-5-5", name: "Sonnet 5.5" },
  { id: "claude-haiku-5-5", name: "Haiku 5.5" },
  { id: "claude-fable-5-1", name: "Fable 5.1" },
];

export const EFFORTS = [
  { id: "", name: "Default effort" },
  { id: "low", name: "Low effort" },
  { id: "medium", name: "Medium effort" },
  { id: "high", name: "High effort" },
  { id: "max", name: "Max effort" },
];

/** Readable name for a Claude model id ("claude-opus-5-5" → "Opus 5.5"). */
export function modelName(id, known = []) {
  const k = [...known, ...CLAUDE_API_MODELS].find(m => m.id == id);
  if (k?.name) {
    return k.name;
  }
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/.exec(id || "");
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}` : id;
}

/**
 * Whether the Messages API takes `output_config.effort` for this model:
 * the Claude 5 family, and Opus 4.6+ / Sonnet 4.6. Haiku 4.5 and older don't.
 */
export function supportsEffort(model) {
  const id = String(model || "").toLowerCase();
  return (
    /claude-(fable|mythos|opus|sonnet|haiku)-5/.test(id) ||
    /claude-opus-4-[6-9]/.test(id) ||
    /claude-sonnet-4-6/.test(id) ||
    /^(opus|sonnet|haiku|fable|default)$/.test(id) // Claude Code aliases
  );
}

/** Key used in settings.hiddenModels. */
export const hiddenKey = (service, model) => `${service}:${model}`;
