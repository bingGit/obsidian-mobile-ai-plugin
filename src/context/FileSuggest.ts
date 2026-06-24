import type { App, TFile } from "obsidian";

export interface FileSuggestion {
  file: TFile;
  score: number;
}

export class FileSuggest {
  constructor(private readonly app: App) {}

  search(query: string, limit = 8): FileSuggestion[] {
    const normalized = normalize(query);

    return this.app.vault
      .getMarkdownFiles()
      .map((file) => ({
        file,
        score: scoreFile(file, normalized)
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path))
      .slice(0, limit);
  }
}

function scoreFile(file: TFile, query: string): number {
  if (!query) {
    return 1;
  }

  const path = normalize(file.path);
  const basename = normalize(file.basename);

  if (basename === query) {
    return 100;
  }

  if (path === query) {
    return 90;
  }

  if (basename.startsWith(query)) {
    return 70;
  }

  if (path.includes(query)) {
    return 50;
  }

  return fuzzyIncludes(path, query) ? 20 : 0;
}

function fuzzyIncludes(value: string, query: string): boolean {
  let cursor = 0;

  for (const char of query) {
    cursor = value.indexOf(char, cursor);

    if (cursor === -1) {
      return false;
    }

    cursor += 1;
  }

  return true;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
