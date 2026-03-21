export interface SuggestionBlock {
  suggestedCode: string;
  prose: string;
}

const SUGGESTION_FENCE_RE = /```suggestion\r?\n([\s\S]*?)\r?\n```/;

export function parseSuggestion(content: string): SuggestionBlock | undefined {
  const match = SUGGESTION_FENCE_RE.exec(content);
  if (!match) {
    return undefined;
  }

  const suggestedCode = match[1];
  const before = content.slice(0, match.index).trimEnd();
  const after = content.slice(match.index + match[0].length).trimStart();
  const prose = [before, after].filter(Boolean).join('\n\n');

  return { suggestedCode, prose };
}
