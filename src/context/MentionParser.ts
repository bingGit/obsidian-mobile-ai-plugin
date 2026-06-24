export interface FileMention {
  token: string;
  path: string;
}

const QUOTED_MENTION = /@"([^"]+\.md)"/gi;
const SIMPLE_MENTION = /@([^\s@]+\.md)/gi;

export function extractFileMentions(input: string): FileMention[] {
  const mentions: FileMention[] = [];
  const seen = new Set<string>();

  for (const match of input.matchAll(QUOTED_MENTION)) {
    addMention(mentions, seen, match[0], match[1]);
  }

  for (const match of input.matchAll(SIMPLE_MENTION)) {
    addMention(mentions, seen, match[0], match[1]);
  }

  return mentions;
}

export function stripMentionTokens(input: string): string {
  return input
    .replace(QUOTED_MENTION, "")
    .replace(SIMPLE_MENTION, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function getActiveMentionQuery(input: string, cursor: number): string | null {
  const beforeCursor = input.slice(0, cursor);
  const at = beforeCursor.lastIndexOf("@");

  if (at === -1) {
    return null;
  }

  const query = beforeCursor.slice(at + 1);

  if (query.includes("\n") || query.includes(" ")) {
    return null;
  }

  return query;
}

function addMention(mentions: FileMention[], seen: Set<string>, token: string, path: string): void {
  if (seen.has(path)) {
    return;
  }

  seen.add(path);
  mentions.push({
    token,
    path
  });
}
