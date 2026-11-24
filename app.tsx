import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

type SaveResult = { path: string; outcome: "saved" | "existing" };
type SyncResult = { id: string; status: string; alreadyRunning: boolean };

async function invoke<T>(method: "save_message" | "save_thread" | "run_sync", input: unknown) {
  const response = await fetch(`/api/v1/plugins/wikisuppy/rpc/${method}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const result = await response.json() as
    | { ok: true; result: T }
    | { ok: false; error: { message: string } };
  if (!result.ok) throw new Error(result.error.message);
  return result.result;
}

function showError(error: unknown) {
  toast.error("wikisuppy", {
    description: error instanceof Error ? error.message : "Операция не выполнена.",
  });
}

function showSaved(saved: SaveResult) {
  toast.success(saved.outcome === "saved" ? "Сохранено в Knowledge" : "Уже сохранено", {
    description: saved.path,
  });
}

export default definePluginApp((app) => {
  app.slots.messageAction({
    id: "save-message",
    title: "Сохранить в wiki",
    icon: "Bookmark",
    async run({ threadId, message, selectedText }) {
      try {
        const saved = await invoke<SaveResult>("save_message", {
          threadId,
          sequence: message.experimental_messageSeq,
          selection: selectedText,
        });
        showSaved(saved);
      } catch (error) {
        showError(error);
      }
    },
  });
  app.commands.register({
    id: "save-thread",
    title: "wikisuppy: сохранить весь тред",
    isAvailable: ({ threadId }) => threadId !== null,
    async run({ threadId }) {
      if (!threadId) return;
      try {
        showSaved(await invoke<SaveResult>("save_thread", { threadId }));
      } catch (error) {
        showError(error);
      }
    },
  });
  app.commands.register({
    id: "run-sync",
    title: "wikisuppy: разобрать исходники",
    async run() {
      try {
        const run = await invoke<SyncResult>("run_sync", null);
        toast.success(run.alreadyRunning ? "Разбор уже идёт" : "Разбор запущен", {
          description: run.id,
        });
      } catch (error) {
        showError(error);
      }
    },
  });
});
