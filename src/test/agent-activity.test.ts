import { describe, expect, it } from "bun:test";
import {
	AgentFeedTail,
	claudeProjectSlug,
	extractSessionIds,
	feedKindForBinary,
	hopCount,
	isLikelyRunning,
	parseClaudeLine,
	parseCodexLine,
	parseLogStem,
	safeSegment,
	summarizeToolInput,
} from "../core/agent-activity.ts";

const byteLen = (s: string): number => Buffer.byteLength(s, "utf8");

describe("safeSegment", () => {
	it("matches the dispatcher's filename sanitizer", () => {
		// dispatch.ps1: ($env:TASK_ID -replace '[<>:"/\\|?*\s]+', '_')
		expect(safeSegment("TASK-640")).toBe("TASK-640");
		expect(safeSegment("In Progress")).toBe("In_Progress");
		expect(safeSegment("Human Review")).toBe("Human_Review");
		// A decimal task id must survive intact — TASK-587.10 collapsing to TASK-587
		// is the create-mr.ps1 bug that opened MRs against a sibling's branch.
		expect(safeSegment("TASK-587.10")).toBe("TASK-587.10");
	});
});

describe("claudeProjectSlug", () => {
	it("derives the real transcript directory name from a Windows project path", () => {
		expect(claudeProjectSlug("D:\\1064n\\Programacion\\claude\\kiero-app")).toBe(
			"D--1064n-Programacion-claude-kiero-app",
		);
	});

	it("handles POSIX paths and dots", () => {
		expect(claudeProjectSlug("/home/me/my.app")).toBe("-home-me-my-app");
	});
});

describe("parseLogStem", () => {
	it("splits a real dispatch log filename", () => {
		const parsed = parseLogStem("20260902-204439-945-52872-TASK-640-In_Review.log");
		expect(parsed).toEqual({
			stem: "20260902-204439-945-52872-TASK-640-In_Review",
			taskId: "TASK-640",
			status: "In Review",
		});
	});

	it("keeps a dashed/decimal task id whole", () => {
		expect(parseLogStem("20260816-100318-001-1234-TASK-587.10-In_Progress.log")?.taskId).toBe("TASK-587.10");
	});

	it("rejects unrelated files", () => {
		expect(parseLogStem("tokens.csv")).toBeNull();
		expect(parseLogStem("watchdog.log")).toBeNull();
		expect(parseLogStem("TASK-640.hop-004")).toBeNull();
	});
});

describe("hopCount", () => {
	it("reports the highest claimed hop for the task", () => {
		const files = ["TASK-640.hop-001", "TASK-640.hop-002", "TASK-640.hop-004", "TASK-641.hop-009", "tokens.csv"];
		expect(hopCount(files, "TASK-640")).toBe(4);
		expect(hopCount(files, "TASK-641")).toBe(9);
	});

	it("returns 0 when the task has never been dispatched", () => {
		expect(hopCount(["TASK-1.hop-001"], "TASK-999")).toBe(0);
	});

	it("does not let a task id prefix-match a longer one", () => {
		// TASK-587 must not absorb TASK-587.10's hops — they are different tasks.
		expect(hopCount(["TASK-587.10.hop-006"], "TASK-587")).toBe(0);
	});
});

describe("extractSessionIds", () => {
	it("takes the LAST session id, so a reworked task resumes the newest round", () => {
		const body = [
			"## Session",
			"Session ID: 11111111-2222-3333-4444-555555555555",
			"",
			"## Session (round 2)",
			"Session ID: 99999999-8888-7777-6666-555555555555",
			"Reviewer Session ID: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		].join("\n");
		const ids = extractSessionIds(body);
		expect(ids.coder).toBe("99999999-8888-7777-6666-555555555555");
		expect(ids.reviewer).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
	});

	it("accepts opencode's ses_* format", () => {
		expect(extractSessionIds("Session ID: ses_18b53e423fferrmR07TRKlOv2G").coder).toBe(
			"ses_18b53e423fferrmR07TRKlOv2G",
		);
	});

	it("does not mistake the reviewer's id for the coder's", () => {
		const ids = extractSessionIds("Reviewer Session ID: 11111111-2222-3333-4444-555555555555");
		expect(ids.coder).toBeUndefined();
		expect(ids.reviewer).toBe("11111111-2222-3333-4444-555555555555");
	});

	it("returns nothing for a task whose agent never recorded a session", () => {
		expect(extractSessionIds("## Description\n\nnothing here")).toEqual({});
	});
});

describe("summarizeToolInput", () => {
	it("strips the dispatcher's powershell interpreter prefix", () => {
		const command = '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command git status';
		expect(summarizeToolInput("Bash", { command })).toBe("git status");
	});

	it("prefers the path for file tools and the pattern for searches", () => {
		expect(summarizeToolInput("Read", { file_path: "/api/app/Models/Transaction.php" })).toBe(
			"/api/app/Models/Transaction.php",
		);
		// Whitespace is collapsed by design, so the padded separator arrives single-spaced.
		expect(summarizeToolInput("Grep", { pattern: "isTransfer", path: "api/app" })).toBe("isTransfer (in api/app)");
	});

	it("falls back to an identifying field for MCP tools", () => {
		expect(summarizeToolInput("task_view", { id: "TASK-640" })).toBe("TASK-640");
	});

	it("never throws on a missing or malformed input", () => {
		expect(summarizeToolInput("Bash", undefined)).toBe("");
		expect(summarizeToolInput("Bash", "not an object")).toBe("");
		expect(summarizeToolInput("Unknown", {})).toBe("");
	});
});

describe("parseClaudeLine", () => {
	it("reads assistant prose and tool calls out of one message", () => {
		const line = JSON.stringify({
			type: "assistant",
			timestamp: "2026-09-02T14:39:17.730Z",
			message: {
				id: "msg_01",
				content: [
					{ type: "text", text: "Checking the failing leg." },
					{ type: "tool_use", name: "Bash", input: { command: "php artisan test --filter=Budget" } },
				],
				usage: { input_tokens: 2, output_tokens: 240, cache_creation_input_tokens: 52787, cache_read_input_tokens: 0 },
			},
		});
		const parsed = parseClaudeLine(line);
		expect(parsed.events).toEqual([
			{ kind: "message", label: "assistant", detail: "Checking the failing leg.", at: "2026-09-02T14:39:17.730Z" },
			{
				kind: "tool",
				label: "Bash",
				detail: "php artisan test --filter=Budget",
				at: "2026-09-02T14:39:17.730Z",
			},
		]);
		expect(parsed.usage).toEqual({ input: 2, output: 240, cacheCreate: 52787, cacheRead: 0, total: 53029 });
		expect(parsed.usageKey).toBe("msg_01");
	});

	it("marks a failed tool result as an error", () => {
		const line = JSON.stringify({
			type: "user",
			message: { content: [{ type: "tool_result", is_error: true, content: "command not found" }] },
		});
		const [event] = parseClaudeLine(line).events;
		expect(event?.kind).toBe("error");
		expect(event?.detail).toBe("command not found");
	});

	it("ignores non-JSON and unrelated record types", () => {
		expect(parseClaudeLine("not json at all").events).toEqual([]);
		expect(parseClaudeLine(JSON.stringify({ type: "file-history-snapshot" })).events).toEqual([]);
	});
});

describe("parseCodexLine", () => {
	it("renders a shell command and flags a non-zero exit", () => {
		const ok = parseCodexLine(
			JSON.stringify({
				type: "item.completed",
				item: { type: "command_execution", command: "git diff --stat", exit_code: 0 },
			}),
		);
		expect(ok.events[0]).toEqual({ kind: "tool", label: "shell", detail: "git diff --stat" });

		const failed = parseCodexLine(
			JSON.stringify({
				type: "item.completed",
				item: { type: "command_execution", command: "vendor/bin/pint --test", exit_code: 1 },
			}),
		);
		expect(failed.events[0]?.kind).toBe("error");
		expect(failed.events[0]?.label).toBe("shell (exit 1)");
	});

	it("labels an MCP call by server and tool", () => {
		const parsed = parseCodexLine(
			JSON.stringify({
				type: "item.completed",
				item: { type: "mcp_tool_call", server: "backlog", tool: "task_view", arguments: { id: "TASK-640" } },
			}),
		);
		expect(parsed.events[0]).toEqual({ kind: "tool", label: "backlog.task_view", detail: "TASK-640" });
	});

	it("treats turn.completed usage as a cumulative replacement, not an addition", () => {
		const parsed = parseCodexLine(
			JSON.stringify({
				type: "turn.completed",
				usage: {
					input_tokens: 2370368,
					cached_input_tokens: 2237184,
					cache_write_input_tokens: 0,
					output_tokens: 6853,
				},
			}),
		);
		expect(parsed.usageAbsolute).toEqual({
			input: 133184, // input_tokens minus the cached portion codex folds into it
			output: 6853,
			cacheCreate: 0,
			cacheRead: 2237184,
			total: 2377221,
		});
		expect(parsed.usage).toBeUndefined();
	});

	it("skips item.started so a command is not rendered twice", () => {
		const started = parseCodexLine(
			JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "ls" } }),
		);
		expect(started.events).toEqual([]);
	});
});

describe("AgentFeedTail", () => {
	it("holds back a partial trailing line until the rest arrives", () => {
		const tail = new AgentFeedTail("codex");
		const full = JSON.stringify({
			type: "item.completed",
			item: { type: "command_execution", command: "git status", exit_code: 0 },
		});
		const split = Math.floor(full.length / 2);

		tail.push(full.slice(0, split), byteLen(full.slice(0, split)));
		// A half-written JSON record must never be parsed — nothing yet.
		expect(tail.recentEvents()).toEqual([]);

		tail.push(`${full.slice(split)}\n`, byteLen(`${full.slice(split)}\n`));
		expect(tail.recentEvents()).toHaveLength(1);
		expect(tail.recentEvents()[0]?.detail).toBe("git status");
	});

	it("counts one assistant message's usage once even when split across lines", () => {
		// Claude repeats the SAME usage object on every JSONL line belonging to one
		// message; summing per line (as the shell reporter does) multi-counts a turn.
		const mk = (block: unknown) =>
			`${JSON.stringify({
				type: "assistant",
				timestamp: "2026-09-02T14:39:17.730Z",
				message: {
					id: "msg_dup",
					content: [block],
					usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
				},
			})}\n`;

		const tail = new AgentFeedTail("claude");
		const a = mk({ type: "text", text: "first" });
		const b = mk({ type: "tool_use", name: "Bash", input: { command: "ls" } });
		tail.push(a + b, byteLen(a + b));

		expect(tail.recentEvents()).toHaveLength(2);
		expect(tail.tokenTotals()).toEqual({ input: 10, output: 5, cacheCreate: 0, cacheRead: 0, total: 15 });
	});

	it("accumulates usage across distinct messages", () => {
		const mk = (id: string) =>
			`${JSON.stringify({
				type: "assistant",
				message: {
					id,
					content: [{ type: "text", text: id }],
					usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
				},
			})}\n`;
		const tail = new AgentFeedTail("claude");
		const chunk = mk("msg_a") + mk("msg_b");
		tail.push(chunk, byteLen(chunk));
		expect(tail.tokenTotals().total).toBe(30);
	});

	it("advances the offset by bytes, not characters", () => {
		const tail = new AgentFeedTail("text");
		const line = "café\n"; // 5 chars, 6 bytes in UTF-8
		tail.push(line, byteLen(line));
		expect(tail.offset).toBe(6);
	});

	it("caps retained events so a long session cannot grow without bound", () => {
		const tail = new AgentFeedTail("text", 10);
		let chunk = "";
		for (let i = 0; i < 50; i++) chunk += `line ${i}\n`;
		tail.push(chunk, byteLen(chunk));
		const events = tail.recentEvents(100);
		expect(events).toHaveLength(10);
		expect(events[events.length - 1]?.detail).toBe("line 49");
	});

	it("reports the newest timestamp it saw", () => {
		const tail = new AgentFeedTail("claude");
		const mk = (ts: string) =>
			`${JSON.stringify({
				type: "assistant",
				timestamp: ts,
				message: { id: ts, content: [{ type: "text", text: "x" }] },
			})}\n`;
		const chunk = mk("2026-09-02T10:00:00.000Z") + mk("2026-09-02T11:00:00.000Z");
		tail.push(chunk, byteLen(chunk));
		expect(tail.lastEventAt()).toBe("2026-09-02T11:00:00.000Z");
	});

	it("discards the fragment a mid-file seek lands on", () => {
		// skipTo puts the offset in the middle of a line; that first fragment is half
		// a JSON record and must never reach the parser.
		const tail = new AgentFeedTail("codex");
		tail.skipTo(500);
		expect(tail.offset).toBe(500);

		const complete = JSON.stringify({
			type: "item.completed",
			item: { type: "command_execution", command: "npm test", exit_code: 0 },
		});
		const chunk = `pe_execution","command":"truncated garbage\n${complete}\n`;
		tail.push(chunk, byteLen(chunk));

		const events = tail.recentEvents();
		expect(events).toHaveLength(1);
		expect(events[0]?.detail).toBe("npm test");
	});

	it("does not drop a line when skipTo targets the start of the file", () => {
		const tail = new AgentFeedTail("text");
		tail.skipTo(0);
		tail.push("first line\n", byteLen("first line\n"));
		expect(tail.recentEvents()[0]?.detail).toBe("first line");
	});

	it("clears everything on reset, for a rotated or truncated file", () => {
		const tail = new AgentFeedTail("text");
		tail.push("a\n", 2);
		tail.reset();
		expect(tail.offset).toBe(0);
		expect(tail.recentEvents()).toEqual([]);
		expect(tail.tokenTotals().total).toBe(0);
	});
});

describe("isLikelyRunning", () => {
	const MIN = 60 * 1000;

	it("reports a working agent as running", () => {
		expect(isLikelyRunning({ pidAlive: true, statusMatches: true, silentMs: 30 * 1000 })).toBe(true);
	});

	it("rejects a recycled pid whose task has already moved on", () => {
		// Observed 2026-09-02: TASK-622/637/638 all sat in Done while their stale
		// .pid files resolved to a live bash / chrome / FileCoAuth process.
		expect(isLikelyRunning({ pidAlive: true, statusMatches: false, silentMs: 10 * 1000 })).toBe(false);
	});

	it("rejects a live pid whose feed has gone silent for hours", () => {
		// TASK-640: the dispatch's pid resolved to an unrelated `node` process
		// started 90 minutes after the log's last write.
		expect(isLikelyRunning({ pidAlive: true, statusMatches: true, silentMs: 120 * MIN })).toBe(false);
	});

	it("tolerates a quiet stretch inside the grace window", () => {
		// A long test run legitimately produces no output for a while.
		expect(isLikelyRunning({ pidAlive: true, statusMatches: true, silentMs: 12 * MIN })).toBe(true);
		expect(isLikelyRunning({ pidAlive: true, statusMatches: true, silentMs: 16 * MIN })).toBe(false);
	});

	it("honours an explicit grace override", () => {
		expect(isLikelyRunning({ pidAlive: true, statusMatches: true, silentMs: 5 * MIN, graceMs: MIN })).toBe(false);
	});

	it("is false whenever the pid is gone, however fresh the output", () => {
		expect(isLikelyRunning({ pidAlive: false, statusMatches: true, silentMs: 0 })).toBe(false);
	});

	it("is false when the log could not be read at all", () => {
		expect(isLikelyRunning({ pidAlive: true, statusMatches: true, silentMs: null })).toBe(false);
	});
});

describe("feedKindForBinary", () => {
	it("maps each dispatched binary to its parser", () => {
		expect(feedKindForBinary("claude")).toBe("claude");
		expect(feedKindForBinary("Claude.CMD".replace(".CMD", ""))).toBe("claude");
		expect(feedKindForBinary("codex")).toBe("codex");
		expect(feedKindForBinary("opencode")).toBe("text");
	});
});
