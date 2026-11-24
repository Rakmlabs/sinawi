/**
 * `/` commands typed into a chat. The CLIs run headless (`claude -p`, `codex exec`, `grok -p`), where their
 * own built-in commands do nothing or turn into prompt text, so Sinawi answers them itself: the app's own
 * commands run, the CLIs' terminal-only commands get a pointer to where the same thing lives in the app.
 * Pure module: the UI (src/composer.ts) and the server (orchestra.ts) share it.
 */
import type { SessionEvent } from "./types.js";

/** Commands the app runs. `new`/`reset` (Codex's and others' names for a fresh context) mean `clear`, `cost` means `usage`. */
export const APP_COMMANDS = ["clear", "compact", "usage", "help"] as const;
export type AppCommand = (typeof APP_COMMANDS)[number];
const ALIASES: Record<string, AppCommand> = { new: "clear", reset: "clear", cost: "usage" };

/** Built-in commands of Claude Code, Codex or Grok that only work in their interactive terminal. */
export const CLI_ONLY_COMMANDS = [
  "model", "status", "config", "settings", "resume", "continue", "memory", "permissions", "approvals", "mcp", "login", "logout",
  "doctor", "exit", "quit", "context", "agents", "hooks", "ide", "vim", "theme", "rewind", "export", "add-dir", "bug", "feedback",
  "release-notes", "upgrade", "statusline", "output-style", "privacy-settings", "terminal-setup", "plugin", "init", "review",
  "security-review", "pr-comments", "diff", "mention", "fast", "todos", "tasks",
] as const;

export type SlashParse =
  | { kind: "app"; command: AppCommand; args: string }
  | { kind: "cli"; name: string };

/**
 * The command a whole message is, if any: `/clear`, `/compact keep the API decisions`. Anything else (a path like
 * `/tmp/x 봐줘`, a skill or custom command the CLI expands itself) is not one and goes to the agent unchanged.
 */
export function parseSlash(text: string): SlashParse | undefined {
  const match = /^\/([a-z][a-z-]*)(?:\s+([\s\S]*))?$/u.exec(text.trim());
  if (!match) return;
  const name = match[1];
  const args = (match[2] ?? "").trim();
  const app = (APP_COMMANDS as readonly string[]).includes(name) ? name as AppCommand : ALIASES[name];
  if (app) return { kind: "app", command: app, args };
  if ((CLI_ONLY_COMMANDS as readonly string[]).includes(name)) return { kind: "cli", name };
  return;
}

/** Where a terminal-only CLI command's job lives in Sinawi (server replies are Korean, like its other errors). */
export function cliOnlyHint(name: string): string {
  const where: Record<string, string> = {
    model: "모델은 입력창 아래 팀 선택에서 바꿉니다.",
    status: "실행 상태는 채팅과 활동 패널에, 사용량은 /usage에 있습니다.",
    context: "맥락을 줄이려면 /compact, 새로 시작하려면 /clear를 쓰세요.",
    resume: "이전 대화는 사이드바에서 그 채팅을 열면 이어집니다.",
    continue: "이전 대화는 사이드바에서 그 채팅을 열면 이어집니다.",
    permissions: "권한은 입력창 아래 권한 모드와 작업 공간 설정에서 바꿉니다.",
    approvals: "권한은 입력창 아래 권한 모드와 작업 공간 설정에서 바꿉니다.",
    mcp: "MCP 도구는 설정의 도구 화면에서 켜고 끕니다.",
    login: "로그인은 설정의 계정 화면이나 터미널에서 CLI로 합니다.",
    logout: "로그인은 설정의 계정 화면이나 터미널에서 CLI로 합니다.",
    init: "\"이 저장소를 살펴보고 CLAUDE.md를 만들어 줘\"처럼 말로 요청하세요.",
    review: "\"지금 변경을 리뷰해 줘\"처럼 말로 요청하세요.",
    "security-review": "\"지금 변경의 보안 문제를 검토해 줘\"처럼 말로 요청하세요.",
  };
  return `/${name}은(는) CLI 터미널 전용 명령이라 Sinawi 채팅에서는 실행되지 않습니다. ${where[name] ?? "Sinawi에서 쓸 수 있는 명령: /clear, /compact, /usage, /help."}`;
}

export const HELP_TEXT = "Sinawi 채팅 명령: /clear — 이 채팅의 에이전트 맥락을 새로 시작(기록은 접어 둠), /compact [지시] — 지금까지를 요약해 그 요약으로 새 세션 시작, /usage — 사용량, /help — 이 안내.";

/** Index of the latest `/clear` or `/compact` marker: the agents' context starts there; -1 when there is none. */
export function lastContextReset(events: readonly SessionEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) if (events[index].metadata?.contextReset) return index;
  return -1;
}

/** The events the agents still know about: everything after the latest `/clear` or `/compact`. */
export function contextEvents<T extends SessionEvent>(events: readonly T[]): T[] {
  return events.slice(lastContextReset(events) + 1);
}
