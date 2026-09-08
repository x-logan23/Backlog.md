/**
 * Structured live activity for dispatched agents.
 *
 * The dispatcher (`backlog/prompts/dispatch.ps1`) launches every coder/reviewer
 * detached and redirects its stdout to `backlog/prompts/logs/<stem>.log`. That
 * file is the only thing the web UI could show until now, and its usefulness
 * varies wildly by agent:
 *
 *   - **codex** is launched with `exec --json`, so its log is already an NDJSON
 *     event stream (`item.started` / `item.completed` / `turn.completed`).
 *   - **claude** is launched with plain `-p`, so its log is only the assistant's
 *     closing prose — no tool calls, no timing, no usage. The rich record lives
 *     in Claude Code's own session transcript
 *     (`~/.claude/projects/<slug>/<sessionId>.jsonl`), which is appended as the
 *     session works and which `token-report.ps1` already reads out-of-band.
 *   - **opencode** emits neither; its log is plain text.
 *
 * This module normalizes all three into one `AgentEvent` stream so the board can
 * render "what is this agent doing right now" the same way regardless of vendor.
 *
 * Everything here is pure and filesystem-free so it can be unit-tested against
 * captured fixtures; the server owns the reading (see `handleGetAgentActivity`).
 */

/** What a single line of an agent feed turned into. */
export type AgentEventKind = "message" | "tool" | "result" | "error" | "system";

export interface AgentEvent {
	kind: AgentEventKind;
	/** Short label — a tool name ("Bash", "Edit"), "assistant", "shell", … */
	label: string;
	/** One-line detail: the command, the file path, an excerpt of the message. */
	detail: string;
	/** ISO timestamp when the feed carries one (claude does, codex does not). */
	at?: string;
}

export interface TokenTotals {
	input: number;
	output: number;
	cacheCreate: number;
	cacheRead: number;
	total: number;
}

/** Which parser a feed needs. Mirrors the agent binary the dispatcher launched. */
export type FeedKind = "claude" | "codex" | "text";

export const emptyTokens = (): TokenTotals => ({ input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 });

/**
 * dispatch.ps1 sanitizes TASK_ID / NEW_STATUS with this exact replacement before
 * building a log filename. Reproduce it verbatim — a mismatch means the UI looks
 * for a file the dispatcher never wrote.
 */
export function safeSegment(value: string): string {
	return value.replace(/[<>:"/\\|?*\s]+/g, "_");
}

/**
 * Claude Code stores a session transcript under a directory named after the
 * project path with every non-alphanumeric character replaced by a dash, e.g.
 * `D:\1064n\Programacion\claude\kiero-app` → `D--1064n-Programacion-claude-kiero-app`
 * (the drive colon and the first separator both collapse to a dash, which is why
 * the slug has a double dash near the front).
 */
export function claudeProjectSlug(projectPath: string): string {
	return projectPath.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Collapse whitespace and clip, so one event is always one readable line. */
function oneLine(value: string, max = 200): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The dispatcher runs most shell work through a fully-qualified powershell.exe,
 * so a raw command starts with ~80 characters of interpreter path that pushes the
 * actual command off the end of the pane. Strip it for display only.
 */
function stripShellPrefix(command: string): string {
	return command.replace(/^"?[^"]*powershell(?:\.exe)?"?\s+(?:-\w+\s+)*/i, "").replace(/\\r\\n/g, " ");
}

/**
 * Reduce a tool call's input object to the one value a human scanning the pane
 * actually wants: the command for Bash, the path for a file tool, the pattern for
 * a search. Falls back to the first string-ish value rather than dumping JSON.
 */
export function summarizeToolInput(name: string, input: unknown): string {
	if (!input || typeof input !== "object") return "";
	const obj = input as Record<string, unknown>;
	const str = (key: string): string => (typeof obj[key] === "string" ? (obj[key] as string) : "");

	switch (name) {
		case "Bash":
		case "PowerShell":
			return oneLine(stripShellPrefix(str("command")) || str("description"));
		case "Read":
		case "Write":
		case "NotebookEdit":
			return oneLine(str("file_path") || str("notebook_path"));
		case "Edit": {
			const path = str("file_path");
			const old = str("old_string");
			return oneLine(old ? `${path} — ${old.slice(0, 60)}` : path);
		}
		case "Grep":
		case "Glob": {
			const pattern = str("pattern");
			const path = str("path");
			return oneLine(path ? `${pattern}  (in ${path})` : pattern);
		}
		case "Agent":
		case "Task":
			return oneLine(str("description") || str("prompt"));
		case "WebFetch":
		case "WebSearch":
			return oneLine(str("url") || str("query"));
		default:
			break;
	}

	// MCP tools and anything unknown: prefer an obvious identifying field, then
	// the first short string value, so a new tool still renders something useful.
	for (const key of ["id", "taskId", "description", "command", "file_path", "path", "query", "pattern"]) {
		const value = str(key);
		if (value) return oneLine(value);
	}
	for (const value of Object.values(obj)) {
		if (typeof value === "string" && value.trim()) return oneLine(value);
	}
	return "";
}

/** Extract readable text from a tool_result block's polymorphic `content`. */
function toolResultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const block of content) {
			if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
				parts.push((block as { text: string }).text);
			}
		}
		return parts.join(" ");
	}
	return "";
}

interface ParsedLine {
	events: AgentEvent[];
	/** Usage to ADD to the running total (already de-duplicated by the caller). */
	usage?: TokenTotals;
	/** Cumulative usage that REPLACES the running total (codex reports totals). */
	usageAbsolute?: TokenTotals;
	/** A message id whose usage was counted, so repeats can be skipped. */
	usageKey?: string;
}

const NO_EVENTS: ParsedLine = { events: [] };

/**
 * One line of a Claude Code session transcript (`<sessionId>.jsonl`).
 *
 * An assistant *message* can span several JSONL lines (one per content block)
 * and every one of them repeats the SAME `message.usage` object. Summing blindly
 * therefore multi-counts a turn — hence `usageKey`, which lets the caller count
 * each `message.id` exactly once.
 */
export function parseClaudeLine(line: string): ParsedLine {
	let record: Record<string, unknown>;
	try {
		record = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return NO_EVENTS;
	}

	const type = record.type;
	const at = typeof record.timestamp === "string" ? record.timestamp : undefined;

	if (type === "assistant") {
		const message = record.message as Record<string, unknown> | undefined;
		if (!message) return NO_EVENTS;
		const events: AgentEvent[] = [];
		const content = Array.isArray(message.content) ? message.content : [];
		for (const raw of content) {
			const block = raw as Record<string, unknown>;
			if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
				events.push({ kind: "message", label: "assistant", detail: oneLine(block.text, 400), at });
			} else if (block.type === "tool_use") {
				const name = typeof block.name === "string" ? block.name : "tool";
				events.push({ kind: "tool", label: name, detail: summarizeToolInput(name, block.input), at });
			}
		}

		const usageRaw = message.usage as Record<string, unknown> | undefined;
		let usage: TokenTotals | undefined;
		if (usageRaw) {
			const num = (key: string): number => (typeof usageRaw[key] === "number" ? (usageRaw[key] as number) : 0);
			const input = num("input_tokens");
			const output = num("output_tokens");
			const cacheCreate = num("cache_creation_input_tokens");
			const cacheRead = num("cache_read_input_tokens");
			usage = { input, output, cacheCreate, cacheRead, total: input + output + cacheCreate + cacheRead };
		}
		const usageKey = typeof message.id === "string" ? message.id : undefined;
		return { events, usage, usageKey };
	}

	if (type === "user") {
		const message = record.message as Record<string, unknown> | undefined;
		const content = message?.content;
		if (!Array.isArray(content)) return NO_EVENTS;
		const events: AgentEvent[] = [];
		for (const raw of content) {
			const block = raw as Record<string, unknown>;
			if (block.type !== "tool_result") continue;
			const text = oneLine(toolResultText(block.content), 160);
			const isError = block.is_error === true;
			events.push({
				kind: isError ? "error" : "result",
				label: isError ? "error" : "result",
				detail: text,
				at,
			});
		}
		return { events };
	}

	return NO_EVENTS;
}

/**
 * One line of a Codex `exec --json` stream.
 *
 * Codex carries no per-event timestamps, so events from this feed have no `at`
 * and the caller falls back to the log file's mtime for "last activity".
 * `turn.completed` reports a CUMULATIVE usage for the turn, so it replaces the
 * running total rather than adding to it.
 */
export function parseCodexLine(line: string): ParsedLine {
	let record: Record<string, unknown>;
	try {
		record = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return NO_EVENTS;
	}

	const type = record.type;

	if (type === "thread.started") {
		const id = typeof record.thread_id === "string" ? record.thread_id : "";
		return { events: [{ kind: "system", label: "session", detail: id }] };
	}

	if (type === "turn.failed") {
		const error = record.error;
		const detail = typeof error === "string" ? error : oneLine(JSON.stringify(error ?? {}), 200);
		return { events: [{ kind: "error", label: "turn failed", detail }] };
	}

	if (type === "turn.completed") {
		const usageRaw = record.usage as Record<string, unknown> | undefined;
		if (!usageRaw) return NO_EVENTS;
		const num = (key: string): number => (typeof usageRaw[key] === "number" ? (usageRaw[key] as number) : 0);
		// Codex folds cache reads into input_tokens; report them separately so the
		// pane's "input" column means the same thing it does for claude.
		const cacheRead = num("cached_input_tokens");
		const input = Math.max(0, num("input_tokens") - cacheRead);
		const output = num("output_tokens");
		const cacheCreate = num("cache_write_input_tokens");
		return {
			events: [],
			usageAbsolute: { input, output, cacheCreate, cacheRead, total: input + output + cacheCreate + cacheRead },
		};
	}

	// Only `item.completed` is rendered for shell/mcp work: `item.started` carries
	// the same id and would double every command in the pane. `agent_message` has
	// no started/completed pair worth distinguishing either.
	if (type !== "item.completed") return NO_EVENTS;
	const item = record.item as Record<string, unknown> | undefined;
	if (!item) return NO_EVENTS;

	if (item.type === "agent_message" && typeof item.text === "string") {
		return { events: [{ kind: "message", label: "assistant", detail: oneLine(item.text, 400) }] };
	}

	if (item.type === "command_execution") {
		const command = typeof item.command === "string" ? stripShellPrefix(item.command) : "";
		const exit = typeof item.exit_code === "number" ? item.exit_code : undefined;
		const failed = exit !== undefined && exit !== 0;
		return {
			events: [
				{
					kind: failed ? "error" : "tool",
					label: failed ? `shell (exit ${exit})` : "shell",
					detail: oneLine(command),
				},
			],
		};
	}

	if (item.type === "mcp_tool_call") {
		const server = typeof item.server === "string" ? item.server : "mcp";
		const tool = typeof item.tool === "string" ? item.tool : "call";
		const failed = item.error != null;
		return {
			events: [
				{
					kind: failed ? "error" : "tool",
					label: `${server}.${tool}`,
					detail: summarizeToolInput(tool, item.arguments),
				},
			],
		};
	}

	return NO_EVENTS;
}

/** A plain-text log line (opencode, or claude's `-p` prose). */
export function parseTextLine(line: string): ParsedLine {
	const trimmed = line.trim();
	if (!trimmed) return NO_EVENTS;
	return { events: [{ kind: "message", label: "output", detail: oneLine(trimmed, 400) }] };
}

/**
 * Incremental tail over one agent feed.
 *
 * A coder's transcript reaches double-digit megabytes, and the board polls every
 * few seconds — re-reading and re-parsing the whole file each time would burn
 * more CPU than the agents do. This keeps a byte offset plus the running totals,
 * so each poll only parses what was appended since the last one.
 *
 * The caller is responsible for detecting truncation/rotation and calling
 * {@link reset}; `offset` is exposed for exactly that comparison.
 */
export class AgentFeedTail {
	private _offset = 0;
	/** Trailing bytes of the last chunk that did not end in a newline. */
	private pending = "";
	private readonly events: AgentEvent[] = [];
	private tokens: TokenTotals = emptyTokens();
	private readonly countedUsage = new Set<string>();
	/** Set by {@link skipTo}: the first line after a mid-file seek is a fragment. */
	private dropNextLine = false;

	constructor(
		private readonly kind: FeedKind,
		private readonly maxEvents = 200,
	) {}

	get offset(): number {
		return this._offset;
	}

	reset(): void {
		this._offset = 0;
		this.pending = "";
		this.events.length = 0;
		this.tokens = emptyTokens();
		this.countedUsage.clear();
		this.dropNextLine = false;
	}

	/**
	 * Start reading from `offset` instead of byte 0.
	 *
	 * Used when first attaching to a feed that is already very large: parsing
	 * megabytes of history the user will never scroll to costs more than it is
	 * worth. A mid-file offset almost never lands on a line boundary, so the first
	 * line that arrives is a fragment and is discarded — parsing half a JSON
	 * record would otherwise emit a garbage event.
	 */
	skipTo(offset: number): void {
		this._offset = Math.max(0, offset);
		this.pending = "";
		this.dropNextLine = this._offset > 0;
	}

	/**
	 * Consume newly-appended text. `byteLength` is what the offset advances by —
	 * pass the byte count actually read, which differs from `chunk.length` for any
	 * non-ASCII content.
	 */
	push(chunk: string, byteLength: number): void {
		this._offset += byteLength;
		const combined = this.pending + chunk;
		const lines = combined.split("\n");
		// The final element is either an incomplete line or "" — hold it back until
		// the rest of it arrives, or a JSON record would be parsed half-written.
		this.pending = lines.pop() ?? "";

		const parse = this.kind === "claude" ? parseClaudeLine : this.kind === "codex" ? parseCodexLine : parseTextLine;

		for (const line of lines) {
			if (this.dropNextLine) {
				// First line after a mid-file seek: a fragment, not a record.
				this.dropNextLine = false;
				continue;
			}
			if (!line.trim()) continue;
			const parsed = parse(line);
			for (const event of parsed.events) this.events.push(event);
			if (parsed.usageAbsolute) {
				this.tokens = parsed.usageAbsolute;
			} else if (parsed.usage) {
				// Count a given assistant message's usage once, however many content
				// blocks (and therefore JSONL lines) it was split across.
				const key = parsed.usageKey;
				if (!key || !this.countedUsage.has(key)) {
					if (key) this.countedUsage.add(key);
					const u = parsed.usage;
					this.tokens = {
						input: this.tokens.input + u.input,
						output: this.tokens.output + u.output,
						cacheCreate: this.tokens.cacheCreate + u.cacheCreate,
						cacheRead: this.tokens.cacheRead + u.cacheRead,
						total: this.tokens.total + u.total,
					};
				}
			}
		}

		if (this.events.length > this.maxEvents) {
			this.events.splice(0, this.events.length - this.maxEvents);
		}
	}

	/** The most recent events, oldest first, capped at `limit`. */
	recentEvents(limit = 40): AgentEvent[] {
		return this.events.slice(-limit);
	}

	tokenTotals(): TokenTotals {
		return this.tokens;
	}

	/** Timestamp of the newest event that carried one (claude feeds only). */
	lastEventAt(): string | undefined {
		for (let i = this.events.length - 1; i >= 0; i--) {
			const at = this.events[i]?.at;
			if (at) return at;
		}
		return undefined;
	}
}

/**
 * Session ids recorded in a task's `## Session` block by the agents themselves.
 *
 * Both formats are accepted: a UUID (claude, codex) and opencode's `ses_*`. The
 * LAST occurrence wins — a task that bounced through several rework rounds
 * accumulates one block per round, and the newest is the live one.
 */
export function extractSessionIds(rawContent: string): { coder?: string; reviewer?: string } {
	const idPattern = "([a-f0-9-]{36}|ses_[A-Za-z0-9]+)";
	const coder = [...rawContent.matchAll(new RegExp(`^Session ID:\\s*${idPattern}`, "gm"))].at(-1)?.[1];
	const reviewer = [...rawContent.matchAll(new RegExp(`^Reviewer Session ID:\\s*${idPattern}`, "gm"))].at(-1)?.[1];
	return { coder, reviewer };
}

export interface LogStem {
	stem: string;
	taskId: string;
	status: string;
}

/**
 * Decompose a dispatch log filename.
 *
 * dispatch.ps1 builds it as
 * `{yyyyMMdd}-{HHmmss}-{fff}-{dispatchPID}-{safeTaskId}-{safeStatus}.log`, and
 * the task id itself may contain dashes (`TASK-587.10`), so the id is everything
 * between the PID and the trailing status rather than a fixed field.
 */
export function parseLogStem(fileName: string, suffix = ".log"): LogStem | null {
	if (!fileName.endsWith(suffix)) return null;
	const stem = fileName.slice(0, -suffix.length);
	const parts = stem.split("-");
	if (parts.length < 6) return null;
	const status = (parts[parts.length - 1] ?? "").replace(/_/g, " ");
	const taskId = parts.slice(4, parts.length - 1).join("-");
	if (!taskId || !status) return null;
	return { stem, taskId, status };
}

/**
 * How many coder/reviewer round trips a task has burned.
 *
 * dispatch.ps1's loop guard claims `<safeTaskId>.hop-NNN` atomically per hop and
 * refuses to dispatch past `maxRoundTrips`. Surfacing the count is the whole
 * point: a task quietly sitting on hop 5 of 6 is about to stop moving, and today
 * nothing shows that until it silently stops.
 */
export function hopCount(files: readonly string[], safeTaskId: string): number {
	const prefix = `${safeTaskId}.hop-`;
	let highest = 0;
	for (const file of files) {
		if (!file.startsWith(prefix)) continue;
		const n = Number.parseInt(file.slice(prefix.length), 10);
		if (Number.isFinite(n) && n > highest) highest = n;
	}
	return highest;
}

/** How long an agent may produce no output before it stops counting as running. */
export const RUNNING_GRACE_MS = 15 * 60 * 1000;

export interface LivenessInput {
	/** `process.kill(pid, 0)` succeeded — necessary, but NOT sufficient. */
	pidAlive: boolean;
	/** The task is still in the status this dispatch was launched for. */
	statusMatches: boolean;
	/** Time since the feed last grew, or null when the log is unreadable. */
	silentMs: number | null;
	graceMs?: number;
}

/**
 * Decide whether a dispatch is really still working.
 *
 * A live PID **cannot** be trusted on its own. Windows recycles process ids
 * aggressively, and the `.pid` files here outlive their agents by days: on
 * 2026-09-02 all four "running" dispatches in this project resolved to a
 * `node`, a `bash`, a `chrome` and a `FileCoAuth` process, each started well
 * AFTER the dispatch that supposedly owned the id. Reporting those as live
 * agents is worse than reporting nothing — it hides that the loop has stalled,
 * which is the single failure this panel exists to make visible.
 *
 * So a dispatch counts as running only with all three of:
 *   1. the pid resolves to *something* (cheap first filter),
 *   2. the task still sits in the status this dispatch was launched for — a
 *      task that reached Done has no coder working on it, whatever the pid says,
 *   3. the feed produced output recently. A genuinely working agent writes
 *      continuously; the watchdog already treats ~10 minutes of silence as
 *      grounds to act, so 15 is a deliberately forgiving display threshold.
 *
 * Callers should still surface `pidAlive` and `silentMs` separately: "process
 * alive but silent for two hours" is precisely the stranded-session tell, and
 * collapsing it into a bare false would throw that signal away.
 */
export function isLikelyRunning({
	pidAlive,
	statusMatches,
	silentMs,
	graceMs = RUNNING_GRACE_MS,
}: LivenessInput): boolean {
	if (!pidAlive || !statusMatches) return false;
	if (silentMs === null) return false;
	return silentMs < graceMs;
}

/** The three states a dispatch badge can be in. */
export type AgentBadgeState = "running" | "stranded" | "completed";

/**
 * Collapse a resolved liveness into the one badge a card shows.
 *
 * Kept here rather than inline in the server so the card and the activity panel
 * cannot drift into disagreeing about what the same dispatch is doing — a
 * spinner on the card beside an "idle" pane is worse than either alone.
 *
 * "stranded" exists because the two honest failure modes look identical from
 * outside: a session that died mid-turn without writing anything more, and a pid
 * the OS handed to something else entirely. Both mean *a human should look*,
 * which "completed" would quietly deny.
 */
export function deriveBadgeState({
	running,
	pidAlive,
	statusMatches,
}: {
	running: boolean;
	pidAlive: boolean;
	statusMatches: boolean;
}): AgentBadgeState {
	if (running) return "running";
	if (pidAlive && statusMatches) return "stranded";
	return "completed";
}

/** Map an agent binary to the feed parser its output needs. */
export function feedKindForBinary(binary: string): FeedKind {
	const normalized = binary.toLowerCase();
	if (normalized === "claude") return "claude";
	if (normalized === "codex") return "codex";
	return "text";
}
