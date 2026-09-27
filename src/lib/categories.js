// What each discovery is, for the filter chips on the log.
//
// Worked out at build time from keyword rules rather than stored in the cache,
// so correcting a rule re-files the whole archive on the next build. Rules are
// tried in order and the first match wins, which is why the narrow ones (agents)
// come before the broad ones (models) that would also match them.

export const CATEGORIES = [
  {
    id: 'agents',
    label: 'Agents',
    match: /\b(agents?|agentic|claude code|codex|coding harness|computer use|skills?)\b/i,
  },
  {
    id: 'ai',
    label: 'AI & models',
    match:
      /\b(ai|agi|llms?|gpt|claude|models?|inference|neural|rag|mlx|qwen|deepseek|huggingface|machine learning|embeddings?|decision engine|continual learning|jev\w*)\b/i,
  },
  {
    id: 'devtools',
    label: 'Dev tools',
    match:
      /\b(ide|debugger|cli|tui|sdk|compiler|linter|git|editor|terminal|cron\w*|monitor(ing)?|diagram|programmable|api|framework|design[- ]tool|testing|profiler)\b/i,
  },
  {
    id: 'systems',
    label: 'Systems',
    match:
      /\b(linux|kernels?|sandbox|gpus?|npus?|rtx\d*|wine|virtuali[sz]ation|containers?|docker|kubernetes|encryption|security|database|filesystem|rootless|air-gapped|dlss\w*)\b/i,
  },
  {
    id: 'apps',
    label: 'Apps',
    match: /\b(alternative|mac|ios|android|desktop|share files|erp|budget|salary|retire|photoshop)\b/i,
  },
  {
    id: 'fun',
    label: 'Visual & fun',
    match: /\b(games?|globe|maps?|atlas|3d|fonts?|chess|pok[eé]mon|fish|anatomy|camera|art)\b/i,
  },
];

export const OTHER = { id: 'other', label: 'Other' };

/** The words an item is judged on: its name, what it says it is, its topics. */
function text(item) {
  const name = (item.name ?? '').split('/').pop().replace(/[-_]/g, ' ');
  return [name, item.title, item.description, ...(item.topics ?? [])].filter(Boolean).join(' ');
}

export function categorize(item) {
  const t = text(item);
  return CATEGORIES.find((c) => c.match.test(t)) ?? OTHER;
}
