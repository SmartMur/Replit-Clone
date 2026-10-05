const DEFAULT_MAX_TOKENS = 16_384;
const DEFAULT_MAX_TURNS = 48;

export const ANTHROPIC_MAX_TOKENS = readIntEnv(
  process.env.ANTHROPIC_MAX_TOKENS,
  DEFAULT_MAX_TOKENS,
);
export const MAX_AGENT_TURNS = readIntEnv(
  process.env.MAX_AGENT_TURNS,
  DEFAULT_MAX_TURNS,
);

/** Nudge the agent to keep building after a premature text-only reply. */
export const MAX_AGENT_CONTINUE_NUDGES = readIntEnv(
  process.env.MAX_AGENT_CONTINUE_NUDGES,
  5,
);

const DEFAULT_MODEL = 'sonnet';

function readIntEnv(value: string | undefined, fallback: number) {
  if (!value?.trim()) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getAnthropicModel() {
  return process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;
}
