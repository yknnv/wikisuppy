import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const threadId = z.string().regex(/^thr_[a-zA-Z0-9_-]{1,80}$/);
export const messageSequence = z.number().int().positive().safe();
export const messageInput = z.object({
  threadId,
  sequence: messageSequence,
  selection: z.string().max(1_000_000).optional(),
});

function serviceName(provider: string) {
  if (provider === "claude-code") return "claude";
  if (provider === "acp-opencode") return "opencode";
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(provider) && provider.length <= 48
    ? provider : "unknown";
}

export async function readBbCapture(bb: BbPluginApi, input: z.input<typeof messageInput>) {
  const request = messageInput.parse(input);
  const [thread, result] = await Promise.all([
    bb.sdk.threads.get({ threadId: request.threadId }),
    bb.sdk.threads.message({ threadId: request.threadId, seq: request.sequence, before: 10 }),
  ]);
  if (thread.deletedAt || thread.visibility === "hidden") {
    throw new Error("Open a visible BB thread to save it.");
  }
  const { message, before } = result;
  const question = message.role === "assistant" ? [...before].reverse().find((row) =>
    row.role === "user" && row.initiator === "user" &&
    (row.turnId === message.turnId || row.turnId === null)) : undefined;
  return {
    adapter: "bb",
    service: serviceName(thread.providerId),
    conversationId: thread.id,
    entryId: String(message.messageSeq),
    title: thread.title ?? "BB conversation",
    createdAt: message.createdAt,
    reference: `@thread:${thread.id}#msg=${message.messageSeq}`,
    context: question?.text.slice(0, 100_000),
    text: request.selection ?? message.text,
    excerpt: request.selection !== undefined,
  };
}
