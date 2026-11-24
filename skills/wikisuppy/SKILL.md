---
name: wikisuppy
description: Save BB messages and threads to Obsidian Knowledge and process the source queue. Use when the user explicitly asks to save something through wikisuppy or start processing sources.
---

Use `bb wikisuppy status` to check the configuration.

- `bb wikisuppy save-thread <ID>` saves a conversation. For the current thread, use `BB_THREAD_ID`.
- `bb wikisuppy save-thread <ID> --raw-only` excludes the source from automatic processing.
- `bb wikisuppy save-message <ID> <sequence>` saves the reply and the question from its turn, when available.
- `bb wikisuppy sync` starts the configured automation or returns the status of an active run.

After saving, report the path to the Markdown file. When starting a sync, link to the thread identified by `threadId` if available, or report the run ID. Wait for completion if the user asks.
