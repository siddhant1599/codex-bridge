# Codex Bridge — agentic coding harness with voice control

Codex Bridge is a locally hosted agentic coding harness for working with Codex from a web dashboard or a private Telegram bot. Give it a task by typing, attaching files, or speaking, and the bridge runs your locally authenticated Codex CLI in the project folder you choose. It keeps conversation history and can resume saved Codex sessions across messages and restarts.

Voice control uses Whisper on your computer to turn dashboard recordings and Telegram voice notes into text. Review a dashboard transcript before sending it; Telegram voice notes are transcribed and submitted automatically. Voice transcription requires the one-time [local setup](#voice-input), but no transcription API key.

- **Work from your browser or phone:** send tasks from the local dashboard or Telegram and follow the conversation in either interface.
- **Use a coding agent:** the included `code-bot-sid` profile gives Codex coding instructions when appropriate. Choose the agent mode and model per conversation.
- **Bring project context:** attach documents or images, select the project folder, and resume a saved session.
- **Stay in control:** stop a running request, view saved history, and choose the Codex sandbox and timeout in your local configuration.

The bridge has no npm dependencies and needs no public server or inbound port: Telegram updates arrive through long polling. Codex still operates within its configured permissions, and individual tool calls are not streamed to the dashboard.

## Setup

Requires Node.js 22.16+ and Codex CLI on PATH. This project was checked against Codex CLI 0.162.1.

1. In Telegram, open **@BotFather**, send `/newbot`, and follow its prompts. Use a dedicated bot for this bridge.
2. In this folder, create your local configuration:

   ```sh
   cp .env.example .env
   chmod 600 .env
   ```

3. Edit `.env` locally and fill in `TELEGRAM_BOT_TOKEN`. Do not paste the token into a chat or commit it.
4. Run `npm run identify`, then send a message to your new bot. The terminal prints the sender's numeric user ID. Copy **your own ID** into `TELEGRAM_ALLOWED_USER_ID`, then press Ctrl+C. Identification mode never invokes Codex or responds to senders.
5. Set `CODEX_WORKDIR` to the project you want Codex to work on. It defaults to this folder. If needed, set `CODEX_BIN` to the absolute path printed by `command -v codex`.
6. Authenticate and start:

   ```sh
   codex login
   npm run check
   npm start
   ```

Choose ChatGPT sign-in to use your subscription. Existing saved authentication is reused; no OpenAI API key is required. Your plan's usage limits still apply. `npm run check` checks the bot, project folder, and local Codex authentication without requesting model work or sending Telegram messages.

Send `/start` to your bot, then a task such as “Explain the files in this project.” For local work while away, keep the computer online and awake. On macOS, run `caffeinate -i npm start` instead of `npm start`; keep that terminal open. This is not an installed login/background service, and closing the laptop can still suspend it.

## Autonomous GitHub work

To let the agent create repositories, commit, and push after you request it, install
Git and GitHub CLI (`gh`), then set these values in your local `.env`:

```dotenv
GH_TOKEN=your_github_personal_access_token
CODEX_SANDBOX=danger-full-access
CODEX_ALLOW_FULL_ACCESS=true
```

Use a GitHub token authorized to create repositories and write their contents.
A classic personal access token with `repo` scope supports private repositories;
organization policies may require additional approval. Add `workflow` scope only
if you need to push GitHub Actions workflow files. Never paste the token into chat.
The agent uses the existing Git author name and email; this does not create a bot account.

Stop the bridge in its terminal and run `npm start` again after editing `.env`.
Then ask it to create your repository and push the project. The token is passed
through the environment, not command arguments, and its exact value is redacted
from bridge messages and saved history. Codex shell commands receive an allowlist
of normal shell variables, Git identity overrides, and GitHub authentication variables
when `GH_TOKEN` is configured. Existing restrictive Codex environment policies may
still prevent credential inheritance.

Full access runs commands with the host user's filesystem and network access,
without approval prompts. It is broader than GitHub-only access. Both settings
are required as an explicit opt-in; defaults remain `workspace-write`.
Managed permission policies can still prohibit it. Restarting the bridge must be
done from your terminal, outside the current agent's restricted session.
The current session cannot expand its own permissions.

See [Codex permissions and environment configuration](https://learn.chatgpt.com/docs/config-file/config-advanced).

## Conversation dashboard

After updating the files, stop the existing bridge with **Ctrl+C**, then run `npm start` again. Open **http://127.0.0.1:8787** in your Mac's browser. The bridge starts the dashboard automatically and also prints incoming Telegram messages, replies, and bridge notices in its terminal.

The dashboard includes:

- A message box to send tasks to the selected conversation. Press Enter to send or Shift+Enter for a new line. New chat and Stop buttons manage the conversation and current request.
- A Record voice button to dictate a message, review its transcript, and send it. Telegram voice notes appear in the same conversation history.
- A conversation sidebar, with separate conversations after `/new` and matching saved conversations after `/resume`.
- Search across titles and message text, timestamps, Codex session IDs, and request status.
- Automatic refresh every two seconds; reading older messages does not force scrolling to the bottom.
- Text export of a selected conversation and an indicator when Telegram delivery fails.
- Persistent local history in `.bridge/history.json`, with owner-only file permissions. Treat exports as private conversation records too.

History begins when the updated bridge starts. Previous messages are **not imported** from Telegram or Codex; the older bridge only saved the most recent response. Requests, replies, and system notices are captured, but individual tool calls and partial model output are not streamed.

To browse the archive while the bridge is stopped, run `npm run dashboard`. This viewer needs no Telegram connection and cannot submit work. Stop it before `npm start` because both use the same port. Optionally add `DASHBOARD_PORT=8788` to `.env` to change the port.

The dashboard listens only on `127.0.0.1`, so it is accessible on this Mac, not directly from your phone. It does not publish history to a hosting service. When launched with `npm start`, you can send tasks from the dashboard or Telegram. Both use the same one-request-at-a-time runner. Sending to an older conversation resumes that conversation and makes it the active conversation for subsequent Telegram messages. Dashboard messages are echoed by the bot in Telegram as “You · Dashboard”, followed by bridge notices and Codex replies in order. Telegram messages are not echoed back a second time. Both interfaces show the same new exchanges; previously dashboard-only exchanges are not backfilled. If Telegram delivery fails, the message stays in dashboard history with a failure indicator and Codex continues working. The standalone `npm run dashboard` archive viewer remains read-only.

## Telegram commands

Voice notes are also supported; see the setup below. Commands work as typed messages in either interface.

| Command | Behavior |
| --- | --- |
| `/help` or `/start` | Show available commands |
| `/status` | Show project, session ID, and whether Codex is working |
| `/model` | Show the selected conversation's current model and available Codex models |
| `/model <model-id>` | Save a model override for this conversation's next task |
| `/model default` | Remove the conversation override; use `CODEX_MODEL` or Codex's configuration/session selection |
| `/agent` | Show coding-agent mode and commands |
| `/agent auto` | Apply code-bot-sid instructions when the request needs coding work (default) |
| `/agent coding` | Explicitly use the coding profile for this conversation |
| `/agent off` | Use standard Codex behavior |
| `/new` | Start a fresh conversation on the next message; files remain intact |
| `/resume <UUID>` | Select an existing local Codex session; the next message resumes it |
| `/stop` | Terminate the current Codex process group; existing edits remain |

Send text to submit work. Requests run one at a time. Additional prompts while busy are rejected with a request to resend, rather than silently queued. `/status` and `/stop` remain usable while Codex runs. Replies are split to fit Telegram's message limit; typing indicators show activity.

To continue a CLI conversation, select its UUID with `/resume`. It must exist in the same local Codex storage. Stop using it in another client before resuming through Telegram; keep the project path consistent. This does not automatically attach to the conversation that created this application, and plugins available in a desktop app may not be available in the CLI.

## Execution and state

The bridge loads the existing [code-bot-sid profile](coding-agent/agent.md) through [its adapter](coding-agent/bridge.js) on each task. In `auto` mode, Codex decides whether the coding profile fits the task; no separate process is spawned for classification. The specialization runs within the same Codex session and permissions. `/agent` settings persist per conversation, and `/new` starts in `auto`. Editing the profile takes effect on the next task. See [coding-agent setup](coding-agent/README.md) for optional Git identity configuration.

Model selection works in both the dashboard and Telegram while idle. Overrides are saved per conversation in history, survive bridge restarts, and are passed to Codex for new and resumed tasks. `/new` starts without a conversation override. Use a model ID available to your Codex account; saving a setting does not validate account access. Codex reports unavailable-model errors when you submit the next task. Removing an override does not force a resumed CLI session to forget its own saved model.

- Only the configured numeric user ID in a private chat can run commands. Group chats and other users are ignored.
- Codex runs with `workspace-write` by default. Choose `read-only` in `.env` for inspection only. Approval policy is `never`: operations needing additional approval fail instead of waiting for a response. This version does not relay interactive approvals or stream tool output.
- Telegram tokens are removed from the child process environment, and `.env` is ignored by Git. This is not secret isolation from Codex: it can read files permitted by its sandbox, including `.env` if this folder is its project. Use a separate project folder when appropriate.
- `.bridge/state.json` stores the bot/owner/current-project binding, next Telegram update offset, and Codex session ID. `.bridge/last-response.txt` keeps the latest reply, including if delivery fails. Both use owner-only permissions. Changing `CODEX_WORKDIR` starts a fresh project conversation and preserves the previous project's conversation history. Changing the Telegram bot or allowed user requires reviewing the `.env` settings; startup won't silently switch who can access saved state.
- Startup automatically removes a stale `.bridge/bridge.lock` when its recorded PID no longer exists, then opens the new connection. No manual cleanup is needed after a normal process crash. An active process, an uninspectable PID, or an invalid lock is preserved; the error explains what to check. Stop an active bridge with Ctrl+C in its original terminal before restarting. This does not delete conversation history or kill another process using the dashboard port. A Telegram 409 error can mean another poller is using the same bot.
- Update offsets are saved **before** execution to avoid automatically replaying file-changing tasks after a crash. A crash between acceptance and execution can therefore lose a request. On restart, interrupted work is reported and not retried automatically. Network delivery failures are logged; the latest reply remains on disk.
- `/stop` and timeouts terminate the child process group. They do not roll back changes. The default request timeout is 30 minutes.
- Voice notes are transcribed locally before being submitted as text. Documents and photos are supported as file attachments; see below.

## Voice input

Voice input uses [Whisper locally](https://github.com/openai/whisper) and FFmpeg on this Mac, without an API key or separate transcription charges. The default multilingual `base` model is about 140 MB. Telegram audio is downloaded from Telegram; dashboard audio is sent only to the local bridge. Transcripts are sent to Codex like typed messages. Replies remain text.

One-time setup, from the bridge folder:

```sh
# Only needed if these tools are missing:
brew install openai-whisper ffmpeg
npm run voice:setup
```

Stop the bridge with Ctrl+C, restart with `npm start`, and refresh the dashboard. The setup command downloads and checks the speech model in `.bridge/voice-models`. It can take several minutes the first time. On this Mac, Whisper and FFmpeg were already installed.

- **Dashboard:** click **Record voice**, allow microphone access, speak, then click **Finish recording**. Review the transcript in the message box and click **Send**. Existing draft text is preserved. **Cancel recording** cancels recording or transcription. Leaving the page or switching conversations cancels the recording too. Use the local dashboard URL printed by the bridge; microphone access requires localhost or HTTPS and a microphone connected to your Mac.
- **Telegram:** record and send a normal voice note to your bot. The bridge transcribes it, echoes the transcript, and submits it automatically as your next task. The dashboard marks it **Voice**. `/stop` cancels transcription or the running Codex task; `/status` stays available. Sending a voice note while a task is running is rejected with a request to resend later.
- Recordings are limited to **two minutes and 10 MB**. Only one transcription runs at a time. Empty, silent, oversized, and failed recordings do not start a Codex task. Speech recognition can make mistakes; use dashboard transcript review for tasks that need exact wording. Voice input accepts spoken tasks; bridge slash commands can still be typed or selected using dashboard buttons.
- The bridge deletes temporary audio and transcription output after success, failure, or cancellation. Only submitted transcripts are saved in history. An abrupt process kill or power loss can leave private temporary files under `.bridge/voice-tmp`; remove that folder while the bridge is stopped if needed. Voice notes remain in Telegram under its normal retention rules.

No `.env` changes are needed for the defaults. Optional settings are documented in `.env.example`: `VOICE_PROVIDER=off` disables voice; `VOICE_MODEL=tiny` is faster, `base` is the default, and `small` trades more time and memory for accuracy. After changing the model, run `npm run voice:setup` again. Set `VOICE_LANGUAGE=en` to force English, or leave it empty for language detection. `WHISPER_BIN`, `FFMPEG_BIN`, and `VOICE_MODEL_DIR` support custom installations. Local transcription runs on CPU and may take longer than the recording on slower Macs; it times out after five minutes.

## Development

```sh
npm test
```

Tests cover access control, durable state, process locking, safe argument construction, real subprocess JSONL handling, failures/timeouts, Telegram response splitting, conversation persistence, dashboard request handling, and the complete message-to-history lifecycle. Voice tests also cover bounded downloads/uploads, microphone permission and cancellation flows, audio cleanup, subprocess cancellation, and Telegram transcript delivery without duplicate execution. They use fake subprocesses, mocked Telegram responses, a simulated browser recorder, and stubbed listeners, so they need no credentials, listening ports, speech models, or model usage. Browser rendering, real microphone permissions, and live Telegram delivery are separate manual checks.

Sources: [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [Codex authentication](https://learn.chatgpt.com/docs/auth), and [Telegram Bot API](https://core.telegram.org/bots/api).

## File attachments

Restart the bridge and refresh the dashboard after updating. In the dashboard, choose up to three files (10 MB each), optionally enter instructions, and click Send. In Telegram, send a document or photo with an optional caption. Send files while the bridge is idle; Telegram album items are handled individually, so send the next file after the reply.

Files are stored with unique names under `.bridge-attachments` in CODEX_WORKDIR. Codex receives their local paths and can inspect them using its tools; support for particular formats depends on the tools available in your project. Filenames and paths appear in conversation history and dashboard messages mirrored to Telegram; file binaries are not mirrored back to Telegram. Stored files persist for follow-up tasks. Delete that folder when no longer needed, and exclude it from project commits if it contains private files.
