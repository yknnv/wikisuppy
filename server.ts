import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { cliCommand, defineCli, defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { messageInput, messageSequence, readBbCapture, threadId } from "./bb-source";
import { captureResult, renderCapture } from "./capture";

const execute = promisify(execFile);
const runDirection = z.object({
  id: z.string(),
  status: z.string(),
  threadId: z.string().nullable(),
  error: z.string().nullable().optional(),
});
const runsResponse = z.object({ runs: z.array(runDirection) });
const syncResult = runDirection.extend({ alreadyRunning: z.boolean() });
const saveThreadInput = z.object({ threadId, rawOnly: z.boolean().default(false) });

const archiveResult = z.object({
  threads_seen: z.number().int().nonnegative(),
  changed: z.number().int().nonnegative(),
  pending: z.array(z.object({
    id: z.string(),
    path: z.string(),
    last_message: z.number().int().nonnegative(),
    wiki_cursor: z.number().int().nonnegative(),
    manual: z.boolean(),
    changed: z.boolean(),
  })),
  source: z.object({ id: z.string(), path: z.string(), changed: z.boolean() }).nullable(),
  errors: z.array(z.object({ id: z.string(), error: z.string() })),
});

export const rpcContract = defineRpcContract({
  save_message: { input: messageInput, output: captureResult },
  save_thread: { input: saveThreadInput, output: captureResult },
  run_sync: { input: z.null(), output: syncResult },
});

function absoluteVaultPath(path: string) {
  if (!isAbsolute(path) || path === "/") {
    throw new Error("Enter an absolute vault path in the wikisuppy settings.");
  }
  return path;
}

function executablePath(configured: string, fallback: string) {
  if (configured && !isAbsolute(configured)) throw new Error("Enter an absolute path to the executable.");
  return configured || fallback;
}

async function findImporter() {
  // Path installs execute the TypeScript entry. Bundled installs run it in dist/.
  for (const path of ["./scripts/import_bb.py", "../scripts/import_bb.py"]) {
    const importer = fileURLToPath(new URL(path, import.meta.url));
    try {
      await access(importer);
      return importer;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  throw new Error("The wikisuppy installation is missing its import script.");
}

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    vaultPath: { type: "string", label: "Markdown folder path on the BB server", default: "" },
    automationProjectId: { type: "string", label: "BB automation project ID", default: "" },
    automationId: { type: "string", label: "Source processing automation ID", default: "" },
    bbExecutable: { type: "string", label: "BB CLI path (if bb is missing from PATH)", default: "" },
    pythonExecutable: { type: "string", label: "Python 3 path (if python3 is missing from PATH)", default: "" },
  });

  function bbExecutable(config: Awaited<ReturnType<typeof settings.get>>) {
    return executablePath(config.bbExecutable, process.env.BB_CLI || "bb");
  }

  async function vaultSettings() {
    const config = await settings.get();
    const rootPath = absoluteVaultPath(config.vaultPath);
    await bb.sdk.files.read({ rootPath, path: join(rootPath, "SCHEMA.md") });
    return { config, rootPath };
  }

  const capturesInFlight = new Map<string, Promise<z.infer<typeof captureResult>>>();
  async function persistCapture(input: Parameters<typeof renderCapture>[0]) {
    const { rootPath } = await vaultSettings();
    const note = renderCapture(input);
    const key = JSON.stringify([rootPath, note.id]);
    const pending = capturesInFlight.get(key);
    if (pending) return { ...await pending, outcome: "existing" as const };

    const write = (async (): Promise<z.infer<typeof captureResult>> => {
      const folder = dirname(note.path);
      const directory = join(rootPath, folder);
      await bb.sdk.files.mkdir({ rootPath, path: directory, recursive: true });
      const { paths } = await bb.sdk.files.listPaths({
        path: directory, query: note.id, limit: 10,
        includeFiles: true, includeDirectories: false, includeHidden: false,
      });
      const existing = paths.find((entry) =>
        entry.path === entry.name && entry.name.endsWith(` — ${note.id}.md`));
      if (existing) {
        return { id: note.id, path: join(folder, existing.name), outcome: "existing" };
      }
      const saved = await bb.sdk.files.write({
        rootPath, path: join(rootPath, note.path), content: note.content,
        expectedSha256: null, mode: 0o600,
      });
      return {
        id: note.id,
        path: note.path,
        outcome: saved.outcome === "conflict" ? "existing" : "saved",
      };
    })();
    capturesInFlight.set(key, write);
    try {
      return await write;
    } finally {
      capturesInFlight.delete(key);
    }
  }

  async function captureMessage(input: z.input<typeof messageInput>) {
    return persistCapture(await readBbCapture(bb, input));
  }

  async function runArchive(options: { thread?: string; rawOnly?: boolean } = {}) {
    const { config, rootPath } = await vaultSettings();
    const executable = executablePath(config.pythonExecutable, "python3");
    const importer = await findImporter();
    const args = [importer, "--vault", rootPath];
    if (options.thread) args.push("--thread", threadId.parse(options.thread));
    if (options.rawOnly) args.push("--raw-only");
    const env = { ...process.env, WIKISUPPY_BB_CLI: bbExecutable(config) };
    try {
      const { stdout } = await execute(executable, args, { env, timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
      return archiveResult.parse(JSON.parse(stdout));
    } catch (error) {
      if (error instanceof Error && "stdout" in error && typeof error.stdout === "string" && error.stdout.trim()) {
        return archiveResult.parse(JSON.parse(error.stdout));
      }
      throw new Error("BB import failed. Check the wikisuppy settings and the paths to BB and Python 3.", { cause: error });
    }
  }

  async function saveThread(input: z.input<typeof saveThreadInput>) {
    const request = saveThreadInput.parse(input);
    const data = await runArchive({ thread: request.threadId, rawOnly: request.rawOnly });
    if (data.errors.length || !data.source) throw new Error("The thread has no messages available to import, or BB returned an error.");
    return {
      id: data.source.id,
      path: data.source.path,
      outcome: data.source.changed ? "saved" as const : "existing" as const,
    };
  }

  async function automationCommand<T>(verb: "runs" | "run", schema: z.ZodType<T>) {
    const config = await settings.get();
    if (!/^proj_[a-zA-Z0-9_-]+$/.test(config.automationProjectId) ||
        !/^auto_[a-zA-Z0-9_-]+$/.test(config.automationId)) {
      throw new Error("Enter the project and automation IDs in the wikisuppy settings.");
    }
    const args = ["automation", verb, config.automationId, "--project", config.automationProjectId, "--json"];
    if (verb === "runs") args.push("--limit", "10");
    try {
      const { stdout } = await execute(bbExecutable(config), args, { timeout: 15_000 });
      return schema.parse(JSON.parse(stdout));
    } catch (error) {
      throw new Error("BB could not complete the automation request. Check its ID and the BB CLI path.", { cause: error });
    }
  }

  let syncRequest: Promise<z.infer<typeof syncResult>> | undefined;
  async function runSync() {
    if (syncRequest) return { ...await syncRequest, alreadyRunning: true };
    syncRequest = (async () => {
      const { runs } = await automationCommand("runs", runsResponse);
      const active = runs.find((run) => ["queued", "pending", "running"].includes(run.status));
      if (active) return { ...active, alreadyRunning: true };
      const { run } = await automationCommand("run", z.object({ run: runDirection }));
      if (run.error || ["failed", "skipped"].includes(run.status)) {
        throw new Error(run.error || "BB could not start source processing.");
      }
      return { ...run, alreadyRunning: false };
    })();
    try {
      return await syncRequest;
    } finally {
      syncRequest = undefined;
    }
  }

  bb.rpc.register(rpcContract, {
    save_message: captureMessage,
    save_thread: saveThread,
    run_sync: runSync,
  });

  bb.cli.register(defineCli({
    name: "wikisuppy",
    summary: "Save BB threads as Markdown and process sources.",
    commands: {
      status: cliCommand({
        summary: "Check vault access and the status of the last sync.",
        async run() {
          await vaultSettings();
          const { runs } = await automationCommand("runs", runsResponse);
          return { exitCode: 0, stdout: JSON.stringify({ vault: "ready", lastRun: runs[0] ?? null }) };
        },
      }),
      "save-thread": cliCommand({
        summary: "Save a full thread to raw.",
        positionals: [{ name: "thread", description: "BB thread ID", required: true }],
        options: { "raw-only": { type: "boolean", description: "Exclude this source from automatic processing" } },
        async run(input) {
          const saved = await saveThread({ threadId: input.positionals.thread, rawOnly: input.options["raw-only"] });
          return { exitCode: 0, stdout: JSON.stringify(saved) };
        },
      }),
      "save-message": cliCommand({
        summary: "Save a BB message and queue it for processing.",
        positionals: [
          { name: "thread", description: "BB thread ID", required: true },
          { name: "sequence", description: "BB message sequence number", required: true },
        ],
        async run(input) {
          const saved = await captureMessage({
            threadId: input.positionals.thread,
            sequence: messageSequence.parse(Number(input.positionals.sequence)),
          });
          return { exitCode: 0, stdout: JSON.stringify(saved) };
        },
      }),
      archive: cliCommand({
        summary: "Import BB chats and return the processing queue as JSON.",
        async run() {
          const archive = await runArchive();
          return { exitCode: archive.errors.length ? 1 : 0, stdout: JSON.stringify(archive) };
        },
      }),
      sync: cliCommand({
        summary: "Start processing or return the active run.",
        async run() {
          return { exitCode: 0, stdout: JSON.stringify(await runSync()) };
        },
      }),
    },
  }));
}
