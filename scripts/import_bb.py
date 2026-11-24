"""Archive visible BB conversations as Markdown and list pending wiki updates."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
from tempfile import NamedTemporaryFile

VAULT = Path(__file__).resolve().parents[2]
WORK = VAULT / ".bb" / "wiki-sync"
STATE = WORK / "wiki-cursors.json"
SYNC_MARKER = "KNOWLEDGE_DAILY_BB_SYNC"


def bb(*args):
    result = subprocess.run(
        [os.environ.get("WIKISUPPY_BB_CLI", "bb"), *args, "--json"], check=True, capture_output=True, text=True, timeout=180
    )
    return json.loads(result.stdout)


def vault_path(path):
    path.resolve().relative_to(VAULT)
    return path


def local_time(milliseconds):
    return datetime.fromtimestamp(milliseconds / 1000).astimezone()


def transcript(events):
    for row in events:
        data = row["data"]
        if row["type"] == "client/turn/requested" and data.get("initiator") == "user":
            parts = [part["text"] for part in data.get("input", []) if part.get("type") == "text"]
            role, body = "User", "\n\n".join(parts)
        elif row["type"] == "item/completed":
            item = data.get("item", {})
            if item.get("type") != "agentMessage" or item.get("parentToolCallId"):
                continue
            role, body = "Assistant", item.get("text", "")
        else:
            continue
        if isinstance(body, str) and body.strip():
            yield row["seq"], role, body, local_time(row["createdAt"])


def fetch(thread, after):
    args = ("--after-seq", str(after), "--limit", "2000") if after else ("--all",)
    return bb("thread", "log", thread["id"], *args)


def archive(thread, path, current, last_seq, raw_only):
    tid = thread["id"]
    while True:
        full_history = not last_seq
        events = fetch(thread, last_seq)
        if not events:
            break
        if not current and any(
            SYNC_MARKER in part.get("text", "")
            for event in events if event["type"] == "client/turn/requested"
            for part in event["data"].get("input", []) if part.get("type") == "text"
        ):
            return None
        messages = list(transcript(events))
        if messages and not current:
            current = f'# {thread["title"] or tid}\n\n- Source: BB\n- Thread: {tid}\n'
        current += "".join(
            f'\n<!-- bb-message:{tid}:{seq} -->\n'
            f'## {role} · {when:%Y-%m-%d %H:%M}\n\n{body}\n'
            for seq, role, body, when in messages
        )
        last_seq = events[-1]["seq"]
        if full_history or len(events) < 2000:
            break

    if raw_only and current and not current.startswith("<!-- wiki-manual -->"):
        current = "<!-- wiki-manual -->\n" + current
    if not current:
        return None

    stored = path.read_text(encoding="utf-8") if path.exists() else ""
    if current != stored:
        path.parent.mkdir(parents=True, exist_ok=True)
        with NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, prefix=".bb-", delete=False) as tmp:
            tmp.write(current)
        os.replace(tmp.name, path)
    last_message = max((int(seq) for seq in re.findall(rf"^<!-- bb-message:{tid}:(\d+) -->$", current, re.M)), default=0)
    return {
        "id": tid, "path": str(path.relative_to(VAULT)), "last_message": last_message,
        "manual": current.startswith("<!-- wiki-manual -->"),
        "changed": current != stored,
    }


def process(thread, existing, raw_only):
    tid = thread["id"]
    provider = {"claude-code": "claude", "acp-opencode": "opencode"}.get(
        thread["providerId"], thread["providerId"] or "unknown"
    )
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", provider):
        provider = "unknown"
    title = re.sub(r'[^\w .,()—–-]', ' ', thread["title"] or "Conversation")
    title = " ".join(title.split())[:80].strip(" .") or "Conversation"
    stamp = local_time(thread["createdAt"]).date()
    original = existing.get(tid)
    path = vault_path(original or VAULT / "raw" / provider / f"{stamp} — {title} — {tid}.md")
    current = path.read_text(encoding="utf-8") if path.exists() else ""
    last_seq = max((int(seq) for seq in re.findall(rf"^<!-- bb-message:{tid}:(\d+) -->$", current, re.M)), default=0)
    return archive(thread, path, current, last_seq, raw_only)


def captures(cursors):
    for path in (VAULT / "raw").glob("*/* — capture_*.md"):
        source_id = path.stem.rsplit(" — ", 1)[-1]
        if not re.fullmatch(r"capture_[0-9a-f]{24}", source_id):
            continue
        try:
            content = vault_path(path).read_text(encoding="utf-8")
        except (ValueError, OSError):
            continue
        if not content.startswith(f"<!-- wikisuppy-capture:{source_id} -->\n"):
            continue
        if f"<!-- bb-message:{source_id}:1 -->" not in content:
            continue
        yield {
            "id": source_id, "path": str(path.relative_to(VAULT)), "last_message": 1,
            "wiki_cursor": cursors.get(source_id, 0), "manual": False, "changed": False,
        }


def main():
    global VAULT, WORK, STATE
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vault", type=Path, required=True, help="Path to the Markdown vault")
    parser.add_argument("--thread", help="Archive one BB thread")
    parser.add_argument("--raw-only", action="store_true", help="Keep the thread out of wiki synthesis")
    args = parser.parse_args()
    VAULT = args.vault.resolve(strict=True)
    if not (VAULT / "SCHEMA.md").is_file():
        parser.error("vault is missing SCHEMA.md")
    WORK = vault_path(VAULT / ".bb" / "wiki-sync")
    WORK.mkdir(parents=True, exist_ok=True)
    STATE = vault_path(WORK / "wiki-cursors.json")
    if args.raw_only and not args.thread:
        parser.error("--raw-only requires --thread")
    selector = ("--thread", args.thread) if args.thread else ()
    threads = bb("thread", "list", "--include-archived", *selector)
    if args.thread and not threads:
        parser.error("BB thread not found")
    if not args.thread:
        threads = [row for row in threads if row["id"] != os.environ.get("BB_THREAD_ID")]

    with vault_path(WORK / "import.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        existing = {
            path.stem.rsplit(" — ", 1)[-1]: path
            for path in (VAULT / "raw").glob("*/* — thr_*.md")
        }
        cursors = json.loads(STATE.read_text(encoding="utf-8")) if STATE.exists() else {}
        manifest, errors = [], []
        with ThreadPoolExecutor(max_workers=6) as pool:
            futures = [(thread, pool.submit(process, thread, existing, args.raw_only)) for thread in threads]
            for thread, future in futures:
                try:
                    result = future.result()
                    if result:
                        result["wiki_cursor"] = cursors.get(result["id"], 0)
                        manifest.append(result)
                except (ValueError, OSError, subprocess.SubprocessError) as error:
                    errors.append({"id": thread["id"], "error": type(error).__name__})
        if not args.thread:
            manifest.extend(captures(cursors))
        pending = [
            item for item in manifest
            if not item["manual"] and item["last_message"] > item["wiki_cursor"]
        ]
        pending.sort(key=lambda item: (item["wiki_cursor"] != 0, item["path"]))
        print(json.dumps({
            "threads_seen": len(threads),
            "changed": sum(item["changed"] for item in manifest),
            "pending": pending,
            "source": manifest[0] if args.thread and manifest else None,
            "errors": errors,
        }, ensure_ascii=False))
        return bool(errors)


if __name__ == "__main__":
    raise SystemExit(main())
