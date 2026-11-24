import { definePluginApp, experimental_THREAD_ACTION_GROUPS } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { SetupPanel } from "./setup-panel";

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
    description: error instanceof Error ? error.message : "The operation could not be completed.",
  });
}

function showSaved(saved: SaveResult) {
  toast.success(saved.outcome === "saved" ? "Saved to Knowledge" : "Already saved", {
    description: saved.path,
  });
}

const saveThreadLabel = "Save thread to wiki";

async function saveThread(threadId: string) {
  try {
    showSaved(await invoke<SaveResult>("save_thread", { threadId }));
  } catch (error) {
    showError(error);
  }
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "setup",
    title: "Set up wikisuppy",
    description: "Choose a Markdown folder for saved chats and topic notes.",
    component: SetupPanel,
  });
  app.slots.experimental_threadAction({
    id: "save-thread",
    title: saveThreadLabel,
    icon: "Bookmark",
    group: experimental_THREAD_ACTION_GROUPS.open,
    item: ({ thread }) => ({
      label: saveThreadLabel,
      icon: "Bookmark",
      run: () => saveThread(thread.id),
    }),
  });
  app.slots.messageAction({
    id: "save-message",
    title: "Save to wiki",
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
    title: "wikisuppy — Save thread",
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ threadId }) => threadId ? saveThread(threadId) : undefined,
  });
  app.commands.register({
    id: "run-sync",
    title: "wikisuppy — Process sources",
    async run() {
      try {
        const run = await invoke<SyncResult>("run_sync", null);
        toast.success(run.alreadyRunning ? "Sync already running" : "Sync started", {
          description: run.id,
        });
      } catch (error) {
        showError(error);
      }
    },
  });
});
