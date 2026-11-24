import { createHash } from "node:crypto";
import { z } from "zod";

export const sourceCapture = z.object({
  adapter: z.string().regex(/^[a-z0-9-]{1,32}$/),
  service: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(48),
  conversationId: z.string().min(1).max(300),
  entryId: z.string().min(1).max(300),
  title: z.string().max(1000),
  createdAt: z.number().int().min(0).max(8.64e15),
  reference: z.string().max(2048).optional(),
  context: z.string().max(100_000).optional(),
  text: z.string().max(1_000_000).refine((text) => text.trim().length > 0),
  excerpt: z.boolean(),
});

export const captureResult = z.object({
  path: z.string(),
  id: z.string(),
  outcome: z.enum(["saved", "existing"]),
});

const dateLabel = new Intl.DateTimeFormat("sv-SE", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function cleanTitle(title: string) {
  return title.replace(/[^\p{L}\p{N} ._(),–—-]/gu, " ")
    .replace(/\s+/gu, " ")
    .slice(0, 64)
    .trim()
    .replace(/\.+$/u, "") || "Conversation";
}

// The adapter owns external IDs; storage and queue semantics are shared.
export function renderCapture(input: z.input<typeof sourceCapture>) {
  const source = sourceCapture.parse(input);
  const identity = JSON.stringify([
    source.adapter, source.service, source.conversationId, source.entryId,
    source.excerpt ? source.text : null,
  ]);
  const id = "capture_" + createHash("sha256").update(identity).digest("hex").slice(0, 24);
  const title = cleanTitle(source.title);
  const date = dateLabel.format(source.createdAt);
  const path = `raw/${source.service}/${date} — ${title} — ${id}.md`;
  const metadata = [
    `- Source: ${source.adapter}`,
    `- Service: ${source.service}`,
    `- Conversation: ${JSON.stringify(source.conversationId)}`,
    `- Message: ${JSON.stringify(source.entryId)}`,
    source.reference && `- Reference: ${source.reference.replace(/[\r\n]/g, " ")}`,
  ].filter(Boolean).join("\n");
  const context = source.context ? `## Question\n\n${source.context}\n\n` : "";
  const content = [
    `<!-- wikisuppy-capture:${id} -->`,
    `# ${title}\n\n${metadata}\n`,
    `<!-- bb-message:${id}:1 -->`,
    `${context}## ${source.excerpt ? "Selected text" : "Message"}\n\n${source.text}\n`,
  ].join("\n");
  return { id, path, content };
}
