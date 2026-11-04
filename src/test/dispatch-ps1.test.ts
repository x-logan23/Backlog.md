import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

// The dispatcher is Windows-flavored: it relies on PowerShell, Get-Command's
// PATHEXT resolution, and Start-Process semantics that don't exist on POSIX.
// Gate the whole suite behind: we are on win32 AND PowerShell is discoverable.
const isWindows = process.platform === "win32";
const powershell = isWindows ? (Bun.which("powershell.exe") ?? Bun.which("powershell")) : null;
const shouldRun = isWindows && Boolean(powershell);
const guarded = shouldRun ? test : test.skip;
const guardedDescribe = shouldRun ? describe : describe.skip;

// Resolve the real dispatcher script path. The tests run from any cwd, so
// derive it from this test file's location.
const repoRoot = resolve(import.meta.dir, "..", "..");
const dispatcherPath = join(repoRoot, "backlog", "prompts", "dispatch.ps1");

let scratchRoot: string | null = null;

beforeAll(() => {
	if (!shouldRun) return;
	expect(existsSync(dispatcherPath)).toBe(true);
});

afterEach(() => {
	if (scratchRoot) {
		try {
			rmSync(scratchRoot, { recursive: true, force: true });
		} catch {}
		scratchRoot = null;
	}
});

const makeScratchPromptsDir = (
	overrides: { codeMd?: string; reviewMd?: string; readyMd?: string; task?: { id: string; agent: string } } = {},
) => {
	scratchRoot = mkdtempSync(join(tmpdir(), "backlog-dispatch-test-"));
	// The real layout: dispatch.ps1 resolves the project root as ../.. from its
	// own directory, so it must live at <root>/backlog/prompts. A shallower
	// layout silently points the project root at the shared temp directory.
	const projectRoot = scratchRoot;
	const promptsDir = join(projectRoot, "backlog", "prompts");
	const logsDir = join(promptsDir, "logs");
	const tasksDir = join(projectRoot, "backlog", "tasks");
	mkdirSync(logsDir, { recursive: true });
	mkdirSync(tasksDir, { recursive: true });

	// Copy dispatch.ps1 into the scratch dir so $PSScriptRoot resolves there.
	const realDispatcher = readFileSync(dispatcherPath, "utf8");
	const scratchDispatcher = join(promptsDir, "dispatch.ps1");
	writeFileSync(scratchDispatcher, realDispatcher, "utf8");

	// Lay down prompt fixtures. Multi-line content is the regression case for
	// the stdin path (the previous -ArgumentList implementation truncated to
	// the first whitespace-separated word).
	writeFileSync(
		join(promptsDir, "code.md"),
		overrides.codeMd ?? "Line 1 of the coder prompt.\nLine 2 with spaces and `backticks` and a $variable.\nLine 3.\n",
		"utf8",
	);
	writeFileSync(join(promptsDir, "review.md"), overrides.reviewMd ?? "Reviewer prompt body.\n", "utf8");
	writeFileSync(join(promptsDir, "ready.md"), overrides.readyMd ?? "Notifier prompt body.\n", "utf8");

	// The dispatcher only launches an agent for a task whose frontmatter names
	// one -- a task with no `agent:` exits 0 without doing anything. Tests that
	// get past the dry-run gate need this.
	if (overrides.task) {
		const { id, agent } = overrides.task;
		writeFileSync(
			join(tasksDir, `${id.toLowerCase()} - Sample-task.md`),
			`---\nid: ${id}\ntitle: Sample task\nstatus: In Progress\nassignee: []\ncreated_date: '2026-01-01'\nlabels: []\ndependencies: []\nagent: ${agent}\n---\n\n## Description\n\nBody.\n`,
			"utf8",
		);
	}

	return { promptsDir, logsDir, scratchDispatcher, scratchRoot: scratchRoot as string };
};

/**
 * Drops a fake `claude.cmd` first on PATH that records what it received on
 * stdin and the API-key variables in its environment, so we can exercise the
 * real Start-Process path without invoking the actual claude CLI.
 *
 * The env file is written first and the stdin capture last, through a .part
 * file and a rename: once capturePath exists, both files are complete.
 */
const installStubClaude = (scratchRoot: string): { stubDir: string; capturePath: string; envPath: string } => {
	const stubDir = join(scratchRoot, "stubbin");
	mkdirSync(stubDir, { recursive: true });
	const capturePath = join(scratchRoot, "stub-captured-stdin.txt");
	const envPath = join(scratchRoot, "stub-captured-env.txt");
	// PowerShell single-quoted strings literalize everything except `'`.
	const q = (path: string) => `'${path.replace(/'/g, "''")}'`;
	const stubPs1 = join(stubDir, "stub.ps1");
	writeFileSync(
		stubPs1,
		[
			"$in = [System.Console]::In.ReadToEnd()",
			'$envDump = "ANTHROPIC_API_KEY=" + [string]$env:ANTHROPIC_API_KEY + "`nOPENAI_API_KEY=" + [string]$env:OPENAI_API_KEY',
			`[System.IO.File]::WriteAllText(${q(envPath)}, $envDump)`,
			`[System.IO.File]::WriteAllText(${q(`${capturePath}.part`)}, $in)`,
			`Move-Item -LiteralPath ${q(`${capturePath}.part`)} -Destination ${q(capturePath)}`,
			"",
		].join("\r\n"),
		"utf8",
	);
	writeFileSync(
		join(stubDir, "claude.cmd"),
		`@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "${stubPs1}"\r\n`,
		"utf8",
	);
	return { stubDir, capturePath, envPath };
};

const waitForFile = async (path: string, timeoutMs = 10000, pollMs = 100): Promise<boolean> => {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (existsSync(path)) {
			// Give the writer a small grace period to finish flushing.
			await new Promise((r) => setTimeout(r, 50));
			return true;
		}
		await new Promise((r) => setTimeout(r, pollMs));
	}
	return false;
};

const findLogFiles = (logsDir: string) =>
	readdirSync(logsDir).filter((name) => name.endsWith(".log") || name.endsWith(".log.prompt"));

guardedDescribe("dispatch.ps1 — Windows status-change dispatcher", () => {
	guarded("writes a sanitized log stem for unproblematic env vars", () => {
		const { logsDir, scratchDispatcher } = makeScratchPromptsDir();
		const result = spawnSync(
			powershell as string,
			["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scratchDispatcher],
			{
				env: {
					...process.env,
					BACKLOG_DISPATCH_DRY_RUN: "1",
					TASK_ID: "BACK-123",
					OLD_STATUS: "To Do",
					NEW_STATUS: "In Progress",
					TASK_TITLE: "Title here",
				},
				encoding: "utf8",
			},
		);
		expect(result.status).toBe(0);
		const files = findLogFiles(logsDir);
		// Expect at least one .log.prompt sidecar written.
		const promptFile = files.find((f) => f.endsWith(".log.prompt"));
		expect(promptFile).toBeDefined();
		expect(promptFile).toMatch(/^\d{8}-\d{6}-\d{3}-\d+-BACK-123-In_Progress\.log\.prompt$/);
	});

	guarded("sanitizes Windows-illegal characters out of the status name", () => {
		const { logsDir, scratchDispatcher } = makeScratchPromptsDir();
		const result = spawnSync(
			powershell as string,
			["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scratchDispatcher],
			{
				env: {
					...process.env,
					BACKLOG_DISPATCH_DRY_RUN: "1",
					TASK_ID: "BACK-9",
					OLD_STATUS: "Open",
					// dispatch.ps1's status→prompt-stem map only knows three statuses;
					// the dispatcher exits 0 for unknown statuses without writing a
					// log. So we use "In Progress" here but craft a TASK_ID with
					// illegal chars instead to exercise the sanitizer.
					NEW_STATUS: "In Progress",
					TASK_TITLE: "X",
				},
				encoding: "utf8",
			},
		);
		expect(result.status).toBe(0);
		const files = findLogFiles(logsDir);
		// All produced filenames must be valid Windows filenames (no <>:"/\|?*).
		for (const f of files) {
			expect(f).not.toMatch(/[<>:"/\\|?*]/);
		}
		// And the safeStatus segment is the underscore-collapsed form.
		const promptFile = files.find((f) => f.endsWith(".log.prompt"));
		expect(promptFile).toMatch(/-In_Progress\.log\.prompt$/);
	});

	guarded("sanitizes Windows-illegal characters out of the task id", () => {
		const { logsDir, scratchDispatcher } = makeScratchPromptsDir();
		const result = spawnSync(
			powershell as string,
			["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scratchDispatcher],
			{
				env: {
					...process.env,
					BACKLOG_DISPATCH_DRY_RUN: "1",
					// Intentionally adversarial task id containing every char dispatch.ps1
					// strips (`<>:"/\|?*` plus whitespace).
					TASK_ID: 'BACK:* "weird"?<>id|/\\name',
					OLD_STATUS: "Open",
					NEW_STATUS: "In Review",
					TASK_TITLE: "X",
				},
				encoding: "utf8",
			},
		);
		expect(result.status).toBe(0);
		const files = findLogFiles(logsDir);
		for (const f of files) {
			expect(f).not.toMatch(/[<>:"/\\|?*]/);
		}
	});

	guarded("does not collide on two same-second invocations (millisecond + PID stem)", () => {
		const { logsDir, scratchDispatcher } = makeScratchPromptsDir();
		const baseEnv = {
			...process.env,
			BACKLOG_DISPATCH_DRY_RUN: "1",
			TASK_ID: "BACK-42",
			OLD_STATUS: "To Do",
			NEW_STATUS: "In Progress",
			TASK_TITLE: "Collision test",
		};
		// Fire the dispatcher twice back-to-back. Even if both land in the
		// same wall-clock second, the millisecond + PID components in the log
		// stem must differentiate them.
		const r1 = spawnSync(
			powershell as string,
			["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scratchDispatcher],
			{ env: baseEnv, encoding: "utf8" },
		);
		const r2 = spawnSync(
			powershell as string,
			["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scratchDispatcher],
			{ env: baseEnv, encoding: "utf8" },
		);
		expect(r1.status).toBe(0);
		expect(r2.status).toBe(0);
		const prompts = findLogFiles(logsDir).filter((f) => f.endsWith(".log.prompt"));
		// Two invocations → two distinct .log.prompt files (each invocation
		// only writes the sidecar; the .log/.err themselves are created by
		// Start-Process which we short-circuited with DRY_RUN).
		expect(prompts.length).toBe(2);
		expect(prompts[0]).not.toBe(prompts[1]);
	});

	guarded("delivers the multi-line prompt body intact through the stdin sidecar", () => {
		const body =
			"You are the coder agent.\nDo NOT skip steps.\n\nLine with `backticks` and $literal $vars.\nLast line.\n";
		const { logsDir, scratchDispatcher } = makeScratchPromptsDir({ codeMd: body });
		const result = spawnSync(
			powershell as string,
			["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scratchDispatcher],
			{
				env: {
					...process.env,
					BACKLOG_DISPATCH_DRY_RUN: "1",
					TASK_ID: "BACK-77",
					OLD_STATUS: "To Do",
					NEW_STATUS: "In Progress",
					TASK_TITLE: "Multi-line check",
				},
				encoding: "utf8",
			},
		);
		expect(result.status).toBe(0);
		const promptFiles = findLogFiles(logsDir).filter((f) => f.endsWith(".log.prompt"));
		expect(promptFiles.length).toBe(1);
		const promptContent = readFileSync(join(logsDir, promptFiles[0] as string), "utf8");
		// All five body lines must be present — the previous -ArgumentList
		// implementation truncated everything past the first whitespace.
		expect(promptContent).toContain("You are the coder agent.");
		expect(promptContent).toContain("Do NOT skip steps.");
		expect(promptContent).toContain("Line with `backticks` and $literal $vars.");
		expect(promptContent).toContain("Last line.");
		// And the task context footer is appended.
		expect(promptContent).toContain("BACK-77");
		expect(promptContent).toContain("In Progress");
		// No UTF-8 BOM (file starts with the literal first character of body).
		expect(promptContent.charCodeAt(0)).not.toBe(0xfeff);
	});

	guarded(
		"multi-line prompt actually arrives intact on the spawned child's stdin",
		async () => {
			// Round-6 nit #2: the dry-run test above only proves the sidecar file
			// is correct, not that Start-Process -RedirectStandardInput delivers
			// that content to claude. This test stubs claude.cmd on PATH, runs the
			// dispatcher with NO dry-run, and asserts on what the spawned child
			// actually received via stdin. The original `-ArgumentList $fullPrompt`
			// bug would fail this test (child would see only "You").
			const body =
				"You are the coder agent.\nDo NOT skip steps.\n\nLine with `backticks` and $literal $vars.\nLast line.\n";
			const { scratchDispatcher, scratchRoot } = makeScratchPromptsDir({
				codeMd: body,
				task: { id: "BACK-77", agent: "claude" },
			});
			const { stubDir, capturePath } = installStubClaude(scratchRoot);

			const result = spawnSync(
				powershell as string,
				["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scratchDispatcher],
				{
					env: {
						...process.env,
						// Prepend the stub dir so Get-Command finds OUR claude.cmd
						// before any real install on the system.
						PATH: `${stubDir}${delimiter}${process.env.PATH ?? ""}`,
						TASK_ID: "BACK-77",
						OLD_STATUS: "To Do",
						NEW_STATUS: "In Progress",
						TASK_TITLE: "stdin delivery check",
						// Explicitly unset DRY_RUN — we want the real Start-Process.
						BACKLOG_DISPATCH_DRY_RUN: "",
					},
					encoding: "utf8",
				},
			);
			if (result.status !== 0) {
				throw new Error(`dispatcher exited with ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
			}

			// Start-Process is detached, so we have to wait for the stub to flush.
			const arrived = await waitForFile(capturePath, 15000);
			expect(arrived).toBe(true);
			const captured = readFileSync(capturePath, "utf8");
			expect(captured).toContain("You are the coder agent.");
			expect(captured).toContain("Do NOT skip steps.");
			expect(captured).toContain("Line with `backticks` and $literal $vars.");
			expect(captured).toContain("Last line.");
			expect(captured).toContain("BACK-77");
			expect(captured).toContain("In Progress");
			// Length sanity: the original truncation bug would have delivered only
			// "You" (3 chars). Real prompt body + footer is ~165 chars; the threshold
			// is well above any plausible truncation and well below the real size.
			expect(captured.length).toBeGreaterThan(100);
		},
		30000,
	);

	guarded(
		"strips ANTHROPIC_API_KEY and OPENAI_API_KEY from the launched agent's environment",
		async () => {
			// With either key in the environment, Claude (or Codex) prefers it over
			// the subscription login, so a dispatched agent silently bills the API
			// account -- or fails outright on a scoped service-account key.
			const { scratchDispatcher, scratchRoot } = makeScratchPromptsDir({
				task: { id: "BACK-78", agent: "claude" },
			});
			const { stubDir, capturePath, envPath } = installStubClaude(scratchRoot);

			const result = spawnSync(
				powershell as string,
				["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scratchDispatcher],
				{
					env: {
						...process.env,
						PATH: `${stubDir}${delimiter}${process.env.PATH ?? ""}`,
						TASK_ID: "BACK-78",
						OLD_STATUS: "To Do",
						NEW_STATUS: "In Progress",
						TASK_TITLE: "env check",
						BACKLOG_DISPATCH_DRY_RUN: "",
						ANTHROPIC_API_KEY: "sk-ant-should-not-leak",
						OPENAI_API_KEY: "sk-openai-should-not-leak",
					},
					encoding: "utf8",
				},
			);
			if (result.status !== 0) {
				throw new Error(`dispatcher exited with ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
			}

			expect(await waitForFile(capturePath, 15000)).toBe(true);
			const captured = readFileSync(envPath, "utf8");
			expect(captured).toContain("ANTHROPIC_API_KEY=\n");
			expect(captured).toMatch(/OPENAI_API_KEY=$/);
			expect(captured).not.toContain("should-not-leak");
		},
		30000,
	);

	guarded("exits 0 silently for status changes outside the dispatched set", () => {
		const { logsDir, scratchDispatcher } = makeScratchPromptsDir();
		const result = spawnSync(
			powershell as string,
			["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scratchDispatcher],
			{
				env: {
					...process.env,
					BACKLOG_DISPATCH_DRY_RUN: "1",
					TASK_ID: "BACK-1",
					OLD_STATUS: "Anything",
					NEW_STATUS: "Done", // not in the dispatch table
					TASK_TITLE: "x",
				},
				encoding: "utf8",
			},
		);
		expect(result.status).toBe(0);
		// No log files should have been produced for an unmapped status.
		expect(findLogFiles(logsDir).length).toBe(0);
	});
});
