import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import type { rpcContract } from "./server";
import type { setupResult, setupState } from "./setup";

const buttonClass = "rounded-md border border-border px-3 py-1.5 text-sm font-medium focus-visible:ring-2 disabled:opacity-50";

function message(error: unknown) {
  return error instanceof Error ? error.message : "The operation could not be completed.";
}

export function SetupPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [suggestion, setSuggestion] = useState<z.infer<typeof setupState> | null>(null);
  const [path, setPath] = useState("");
  const [daily, setDaily] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<z.infer<typeof setupResult> | null>(null);

  useEffect(() => {
    let active = true;
    rpc.call("setup_status").then(
      (value) => {
        if (!active) return;
        setSuggestion(value);
        setPath((current) => current || value.path);
      },
      (cause: unknown) => { if (active) setError(message(cause)); },
    );
    return () => { active = false; };
  }, [rpc]);

  async function chooseFolder() {
    setBusy(true);
    setError("");
    try {
      const picked = await rpc.call("setup_pick");
      if (picked.path) {
        setPath(picked.path);
        setResult(null);
      }
    } catch {
      setError("The folder picker is unavailable. You can enter the path below.");
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setResult(null);
    setError("");
    try {
      const outcome = await rpc.call("setup_apply", { path: path.trim(), daily });
      setResult(outcome);
      setPath(outcome.path);
      setDaily(false);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex max-w-xl flex-col gap-3 text-sm" onSubmit={save}>
      <label className="flex flex-col gap-1 font-medium">
        Markdown folder
        <input
          className="rounded-md border border-border bg-background px-2 py-1.5 font-mono text-sm"
          autoComplete="off"
          value={path}
          spellCheck={false}
          onChange={(event) => { setPath(event.target.value); setResult(null); }}
          required
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass} onClick={chooseFolder} disabled={busy}>Choose folder</button>
        {suggestion?.candidates.filter((item) => item.path !== path).map((item) => (
          <button type="button" key={item.path} className={buttonClass} title={item.path}
            onClick={() => { setPath(item.path); setResult(null); }}>Use {item.project}</button>
        ))}
      </div>
      <label className="flex items-start gap-2">
        <input type="checkbox" checked={daily} onChange={(event) => setDaily(event.target.checked)} />
        <span>
          Create a daily automation if one is missing
          <span className="block text-muted-foreground">
            At 6:00 PM server time, import and process conversations from all BB projects, including Personal and archived threads.
          </span>
        </span>
      </label>
      {suggestion && !suggestion.importToolsAvailable && (
        <p className="text-muted-foreground">Thread imports need the BB CLI and Python 3 on the BB server.</p>
      )}
      <div>
        <button type="submit" className={buttonClass + " bg-primary text-primary-foreground"} disabled={busy || !path.trim()}>
          {busy ? "Working…" : "Set up wikisuppy"}
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {result && (
        <p role="status">
          Markdown folder ready.{" "}
          {result.schedule === "created" && "Daily processing is scheduled."}
          {result.schedule === "existing" && "The existing automation is connected."}
          {result.scheduleError && <>Automation setup could not finish. {result.scheduleError}</>}
        </p>
      )}
    </form>
  );
}
