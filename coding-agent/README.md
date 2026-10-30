# code-bot-sid

A local Codex CLI launcher with custom instructions and Git commit identity.
Edit `agent.md` to add information for the agent. `AGENTS.md` points Codex to
that file when working here; `run.sh` includes its contents when targeting another repository.

## Start

Requires Git and an authenticated Codex CLI (`codex login`). From the parent Agents directory:

```sh
./coding-agent/setup-git.sh /path/to/repository 'YOUR_GITHUB_ASSOCIATED_EMAIL'
./coding-agent/run.sh /path/to/repository 'Implement the requested change and commit it'
```

Replace both placeholders with real values. Omit the task to start an interactive session.
The setup changes `user.name` and `user.email` only in the target repository;
these defaults also apply to manual commits there. It does not change global Git settings.
Existing author/committer environment overrides can take precedence over Git configuration.
Run the launcher from a terminal for interactive Codex use.

## GitHub identity

The commit name is `code-bot-sid`. Supply the actual email for the GitHub identity
you want attributed to the commits. This package does not register a GitHub account
or App, supply push credentials, or create a `[bot]` badge. A separate GitHub bot
profile requires a GitHub App or dedicated account and its corresponding identity
and authentication setup. Existing Git credentials determine push access.

No repository has been configured and no commits or pushes have been made by
creating these files. The parent workspace is currently not a Git repository.
The Telegram/dashboard bridge now integrates this profile through `bridge.js`.

## Bridge integration

Start the parent application with `npm start`. In the default `auto` mode,
the bridge includes `agent.md` with each task and asks Codex to apply it when
the request requires coding, debugging, tests, review, or repository work.
This is model-based selection of instructions, not keyword matching or a
second independent agent process. General conversation remains available.

Commands work from both Telegram and the dashboard:

- `/agent` shows the current setting.
- `/agent auto` uses the coding profile when relevant (default).
- `/agent coding` selects code-bot-sid explicitly.
- `/agent off` uses standard Codex behavior for subsequent tasks.

The setting is saved per conversation. `/new` returns to `auto`.
`agent.md` is read on every request, so instruction edits apply without a restart.
The bridge uses its configured `CODEX_WORKDIR`, not the `coding-agent` folder,
and retains `/model`, `/stop`, session resumption, timeouts, and sandbox permissions.
It does not launch the interactive `run.sh` or change Git configuration.
Ordinary coding tasks do not require a Git identity; configure one with
`setup-git.sh` before requesting commits if the repository needs it.

Official OpenAI documentation:
- [Codex CLI reference](https://learn.chatgpt.com/docs/cli/reference)
- [AGENTS.md instructions](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
