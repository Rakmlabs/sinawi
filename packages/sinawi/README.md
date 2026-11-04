# sinawi

Command-line companion for [Sinawi](https://github.com/Rakmlabs/sinawi), the macOS app that runs the Claude Code, Codex and Grok Build CLIs as one team.

```sh
npx sinawi        # install or update Sinawi.app from the latest GitHub release
npx sinawi mcp    # stdio MCP bridge: lets Claude Desktop, Cursor and other MCP clients use Sinawi
```

macOS only. Node 18 or later. No dependencies.

## Install the app

`npx sinawi` (same as `npx sinawi install`):

1. looks up the latest release of `Rakmlabs/sinawi` on GitHub and downloads its universal `.dmg`;
2. mounts it read-only and checks the app with `codesign --verify --deep --strict` and `spctl -a -t exec` (Developer ID signature and Apple notarization);
3. asks before replacing an existing `/Applications/Sinawi.app`, and stops if Sinawi is running;
4. copies the app with `ditto`, checks the copy again, swaps it in and opens it.

| Option | Meaning |
|---|---|
| `-y`, `--yes` | Replace an existing Sinawi.app without asking. |
| `--no-open` | Do not open Sinawi afterwards. |
| `--dmg <file>` | Install from a `.dmg` you already downloaded. |
| `--dir <folder>` | Install into another folder instead of `/Applications`. |
| `-h`, `--help` / `-v`, `--version` | Help / this package's version. |

Then install and log in to at least one agent CLI (Claude Code, Codex CLI or Grok Build). **Settings → Help & setup assistant** in the app shows what it found.

## Connect an MCP client

Easiest: in Sinawi, open **Settings → General → External AI connection (MCP)** and press **Connect to Claude Desktop** or **Connect to Cursor**. The app shows the exact JSON, merges it into the client's config (other entries stay, the original is kept as `.bak`), and you restart the client.

By hand, with this package (once it is published to npm). Claude Desktop, **Settings → Developer → Edit Config** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "sinawi": {
      "command": "npx",
      "args": ["-y", "sinawi", "mcp"],
      "env": { "SINAWI_URL": "http://127.0.0.1:3001", "SINAWI_MCP_TOKEN": "<token from Sinawi's settings>" }
    }
  }
}
```

Cursor (`~/.cursor/mcp.json`) takes the same `mcpServers` entry. Claude Code:

```sh
claude mcp add sinawi --env SINAWI_MCP_TOKEN=<token> -- npx -y sinawi mcp
```

Without npm, the app carries the same bridge: `node "/Applications/Sinawi.app/Contents/Resources/sinawi-mcp.mjs"`.

Risky tools (deleting, changing settings, merging, terminal commands) do not run when called. They return `pending_approval`, the app shows an approval card, and they run only after you press **Approve** in Sinawi. No tool can approve its own request.

### Bridge environment

| Variable | Default | Meaning |
|---|---|---|
| `SINAWI_URL` | `http://127.0.0.1:${SINAWI_PORT}` | The app's address. |
| `SINAWI_PORT` | `3001` | The app's port, used when `SINAWI_URL` is not set. |
| `SINAWI_MCP_TOKEN` | | The token itself. |
| `SINAWI_MCP_TOKEN_FILE` | | A file to read the token from. |
| `SINAWI_DATA_DIR` | `~/Library/Application Support/dev.sinawi.app/.data` | The app's data folder; the token is read from `app-mcp-token` inside it. |

The token is looked up in that order and reread on every call, so a renewed token works without restarting the client. With none of them set, the bridge reads the app's own token file, so on the Mac where Sinawi runs the `env` block can be left out.

### Errors

- `Sinawi MCP token missing`: no token was found; set `SINAWI_MCP_TOKEN`.
- `Sinawi is not reachable at …`: Sinawi is not running, or `SINAWI_URL`/`SINAWI_PORT` points elsewhere.
- A 401 message from the app: the token is wrong or was renewed; copy the config again.

## More

- [MCP setup and project leads](https://github.com/Rakmlabs/sinawi/blob/main/docs/mcp.md)
- [Reference for AI agents](https://github.com/Rakmlabs/sinawi/blob/main/docs/ai/for-ai.md): every tool, which ones need approval, the HTTP API

## License

MIT
