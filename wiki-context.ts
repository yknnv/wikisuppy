import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";

const maxNoteBytes = 64 * 1024;
const maxNotes = 400;
const maxResults = 3;
const maxExcerpt = 850;
const stopWords = new Set(
  "the and for are was were what where when how can could should does with from about this that our your use using wiki context мне для как где что это или про при еще уже тут чем надо нужно найди подтяни контекст заметки".split(" "),
);

function words(value: string) {
  return (value.normalize("NFKC").toLowerCase().replace(/ё/g, "е").match(/[\p{L}\p{N}]{3,}/gu) ?? [])
    .filter((word) => !stopWords.has(word));
}

function term(word: string) {
  if (word.length < 5) return word;
  if (/^[а-я]+$/u.test(word)) return word.replace(/(?:иями|ями|ами|ого|ему|ому|ыми|ими|иях|ий|ый|ой|ая|ые|ое|ую|ей|ов|ах|ям|ам|ом|ем|[аеёиоуыюя])$/u, "");
  return word.replace(/(?:ing|ed|s)$/u, "");
}

function terms(value: string) {
  return new Set(words(value).map(term));
}

function folderKey(value: string) {
  return value.normalize("NFKC").toLowerCase().trim();
}

const sharedFolders = new Set(["общие темы", "general", "shared"]);

async function* notePaths(directory: string, project: string | undefined, prefix = "", depth = 0): AsyncGenerator<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (depth === 0 && project !== undefined &&
        (!entry.isDirectory() || (!sharedFolders.has(folderKey(entry.name)) && folderKey(entry.name) !== folderKey(project)))) {
      continue;
    }
    const path = prefix + entry.name;
    if (entry.isDirectory() && depth < 5) {
      yield* notePaths(join(directory, entry.name), undefined, path + "/", depth + 1);
    } else if (entry.isFile() && /\.md$/iu.test(entry.name) && !/^(?:agents|schema)\.md$/iu.test(entry.name)) {
      yield path;
    }
  }
}

async function readNote(wiki: string, path: string) {
  const file = join(wiki, path);
  const info = await lstat(file);
  if (!info.isFile() || info.size > maxNoteBytes || await realpath(file) !== file) return "";
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!(await handle.stat()).isFile()) return "";
    const buffer = Buffer.alloc(maxNoteBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    return length <= maxNoteBytes ? buffer.toString("utf8", 0, length) : "";
  } finally {
    await handle.close();
  }
}

function rankNote(path: string, content: string, query: readonly string[]) {
  const title = basename(path).replace(/\.md$/iu, "");
  const titleTerms = terms(title);
  let best: { path: string; excerpt: string; score: number } | undefined;
  // Strip frontmatter and comments, and keep source pointers out of scoring.
  const body = content.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "").replace(/<!--[\s\S]*?-->/gu, "");
  for (const paragraph of body.split(/\r?\n\s*\r?\n/u)) {
    const clean = paragraph.trim();
    if (!clean || /^#{1,6}\s+[^\n]+$/u.test(clean)) continue;
    for (let offset = 0; offset < clean.length; offset += maxExcerpt - 120) {
      const excerpt = clean.slice(offset, offset + maxExcerpt);
      const bodyTerms = terms(excerpt.replace(/!?\[\[raw\/[^\]]+\]\]/giu, ""));
      const matches = query.filter((word) => titleTerms.has(word) || bodyTerms.has(word));
      if (matches.length < Math.min(2, query.length)) continue;
      const score = matches.length * 4 + matches.filter((word) => titleTerms.has(word)).length * 3 +
        matches.filter((word) => bodyTerms.has(word)).length;
      if (!best || score > best.score) {
        best = {
          path: "wiki/" + path,
          excerpt: (offset ? "…" : "") + excerpt + (offset + excerpt.length < clean.length ? "…" : ""),
          score,
        };
      }
      if (offset + excerpt.length >= clean.length) break;
    }
  }
  return best;
}

export async function searchWiki(rootPath: string, query: string, project?: string, signal?: AbortSignal) {
  const tokens = [...terms(query)].slice(0, 20);
  if (!tokens.length) return [];
  const wiki = join(await realpath(rootPath), "wiki");
  const info = await lstat(wiki).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info?.isDirectory()) return [];

  const results: NonNullable<ReturnType<typeof rankNote>>[] = [];
  let candidates = 0;
  for await (const path of notePaths(wiki, project)) {
    signal?.throwIfAborted();
    if (++candidates > maxNotes) break;
    const content = await readNote(wiki, path).catch((error: NodeJS.ErrnoException) => {
      if (["ENOENT", "ELOOP", "EISDIR", "EACCES"].includes(error.code ?? "")) return "";
      throw error;
    });
    const match = rankNote(path, content, tokens);
    if (match) results.push(match);
  }
  return results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, maxResults)
    .map(({ path, excerpt }) => ({ path, excerpt }));
}
