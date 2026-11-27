# wikisuppy

Save BB messages, excerpts, and full threads as Markdown. Open the files in Obsidian or any Markdown editor. Keep the folder in iCloud Drive or another cloud storage service to sync it across devices. A linked BB automation processes saved sources and updates your topic notes and index.

## Usage

- Choose **Save to wiki** in a message’s action bar or from the text selection menu.
- Choose **Save thread to wiki** from the `⋯` menu next to a thread in the sidebar.
- Open the BB command palette (`⌘⇧P` on Mac) and choose **wikisuppy — Save thread** or **wikisuppy — Process sources**.
- From the terminal, run `bb wikisuppy status`, `bb wikisuppy sync`, or `bb wikisuppy save-thread <ID>`. Add `--raw-only` to exclude a thread from automatic processing.

## Wiki context in BB

Once the Markdown folder is configured, BB agents can search your wiki when a request depends on past decisions, conventions, or research. For example, ask “Based on our wiki, how is the autopilot schedule configured?” The agent receives up to three excerpts with their Markdown paths. The search covers the folder in `wiki/` named after the current BB project and shared folders (`Общие темы`, `General`, or `Shared`). A project connected to the configured vault can search the full `wiki/` tree. Searches use topic notes and skip the raw chat archive.

Turn off **Use wiki context in BB agent sessions** in wikisuppy settings to remove the tool from new agent sessions. Start a new thread to pick up changes to tool availability. For a direct search across the wiki, run `bb wikisuppy context "autopilot schedule"`.

## Installation

Install **wikisuppy** from BB Community. Open its settings and use **Set up wikisuppy**. An existing Markdown vault in a registered project is suggested automatically. You can also choose a folder or use the default `~/Knowledge`. Setup creates missing starter files and keeps existing ones.

Choose **Create a daily automation if one is missing** to process conversations from all BB projects at 6:00 PM server time. Setup reuses a matching automation and uses an available BB provider when creating one. The BB CLI and Python 3 are discovered on the server. The advanced settings support explicit overrides.

From the terminal, run `bb wikisuppy setup`. To choose a non-default folder and enable scheduling, run `bb wikisuppy setup /absolute/path --daily`.

### Install from source

You need BB, Node.js and npm for building, and Python 3 for importing threads. The BB server needs access to the Markdown folder.

```sh
npm ci
npm run check
bb plugin build
bb plugin install .
```

Use the same setup form after installing from source.

Use `bb wikisuppy archive` as the import step in an existing Knowledge automation. It returns JSON with `pending` and `errors` fields and uses the existing archive, import lock, and `.bb/wiki-sync/wiki-cursors.json` file. Each queue entry has a source ID, a path relative to the vault, the last message number, and the processing cursor. A source can be a BB thread or a single capture. See [the automation template](automation.md) to set up a new scheduled run.

## Source adapters

The BB adapter in `bb-source.ts` converts a message into the `sourceCapture` contract defined in `capture.ts`. The contract includes the adapter name, service, conversation and message IDs, date, title, text, excerpt flag, and optional reference and context. The service determines the folder under `raw/<service>/`. The adapter name, service, external IDs, and selected text determine the capture ID so repeated saves can reuse the same source.

The current release includes the BB adapter. Future adapters for ChatGPT, Claude, and Gemini can use the same contract to pass their source data to the capture handler.

Saved sources retain the original text and a reference to the message. For assistant replies, they also include the question from the same turn when available. The vault’s `SCHEMA.md` governs topic folders and log entries. Follow the vault’s instructions for deletion approval.
