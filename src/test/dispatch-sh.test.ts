import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// dispatch.sh is the POSIX dispatcher; its Windows sibling is covered by
// dispatch-ps1.test.ts, which is skipped off win32 for the same reason this is
// skipped on it.
const shouldRun = process.platform !== "win32";
const guarded = shouldRun ? test : test.skip;

const repoRoot = resolve(import.meta.dir, "..", "..");
const dispatcherPath = join(repoRoot, "backlog", "prompts", "dispatch.sh");

let scratchBase: string | null = null;

beforeAll(() => {
	if (!shouldRun) return;
	expect(existsSync(dispatcherPath)).toBe(true);
});

afterEach(() => {
	if (scratchBase) {
		try {
			rmSync(scratchBase, { recursive: true, force: true });
		} catch {}
		scratchBase = null;
	}
});

/**
 * Lays out:
 *   <base>/project/backlog/prompts/dispatch.sh   (project root is <base>/project)
 *   <base>/project/backlog/tasks/<id> - Title.md
 *   <base>/outside/.git                          (an escape target for traversal)
 */
const makeProject = (frontmatterExtra = "", taskId = "BACK-1") => {
	scratchBase = mkdtempSync(join(tmpdir(), "backlog-dispatch-sh-"));
	const projectRoot = join(scratchBase, "project");
	const promptsDir = join(projectRoot, "backlog", "prompts");
	const tasksDir = join(projectRoot, "backlog", "tasks");
	mkdirSync(promptsDir, { recursive: true });
	mkdirSync(join(promptsDir, "logs"), { recursive: true });
	mkdirSync(tasksDir, { recursive: true });

	// A repo outside the project root, to prove containment is what rejects a
	// traversal rather than the directory simply not existing.
	mkdirSync(join(scratchBase, "outside", ".git"), { recursive: true });

	const scratchDispatcher = join(promptsDir, "dispatch.sh");
	writeFileSync(scratchDispatcher, readFileSync(dispatcherPath, "utf8"), { mode: 0o755 });
	writeFileSync(join(promptsDir, "code.md"), "Coder prompt body.\n");
	writeFileSync(join(promptsDir, "review.md"), "Reviewer prompt body.\n");

	// Filename is lowercase while the id is uppercase — the real-world shape.
	writeFileSync(
		join(tasksDir, `${taskId.toLowerCase()} - Sample-task.md`),
		`---\nid: ${taskId}\ntitle: Sample task\nstatus: In Progress\nassignee: []\ncreated_date: '2026-01-01'\nlabels: []\ndependencies: []\nagent: claude\n${frontmatterExtra}---\n\n## Description\n\nBody.\n`,
	);

	// macOS puts the temp dir behind the /var -> /private/var symlink, and the
	// dispatcher reports the resolved path (`pwd -P`), so compare against that.
	return { projectRoot, realProjectRoot: realpathSync(projectRoot), promptsDir, scratchDispatcher, tasksDir };
};

const runDispatcher = (
	scratchDispatcher: string,
	env: Record<string, string> = {},
	{ dryRun = true }: { dryRun?: boolean } = {},
) =>
	spawnSync("sh", [scratchDispatcher], {
		encoding: "utf8",
		env: {
			...process.env,
			TASK_ID: "BACK-1",
			TASK_TITLE: "Sample task",
			OLD_STATUS: "To Do",
			NEW_STATUS: "In Progress",
			...(dryRun ? { BACKLOG_DISPATCH_DRY_RUN: "1" } : {}),
			...env,
		},
	});

const readPromptFile = (promptsDir: string): string => {
	const logsDir = join(promptsDir, "logs");
	const prompt = readdirSync(logsDir).find((f) => f.endsWith(".prompt"));
	expect(prompt).toBeTruthy();
	return readFileSync(join(logsDir, String(prompt)), "utf8");
};

describe("dispatch.sh — target repository resolution", () => {
	guarded("runs at the project root when the task names no repo", () => {
		const { projectRoot, scratchDispatcher } = makeProject();
		const result = runDispatcher(scratchDispatcher);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain(`workdir=${projectRoot}`);
		// No repo mentioned at all for a single-repo project.
		expect(result.stdout).not.toContain("repo:");
	});

	guarded("resolves a repo directory under the project root", () => {
		const { projectRoot, realProjectRoot, scratchDispatcher } = makeProject("repo: payments-api\n");
		mkdirSync(join(projectRoot, "payments-api", ".git"), { recursive: true });
		const result = runDispatcher(scratchDispatcher);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain(`workdir=${join(realProjectRoot, "payments-api")}`);
		expect(result.stdout).toContain("(repo: payments-api)");
	});

	guarded("resolves a nested repo path", () => {
		const { projectRoot, realProjectRoot, scratchDispatcher } = makeProject("repo: platform/billing\n");
		mkdirSync(join(projectRoot, "platform", "billing", ".git"), { recursive: true });
		const result = runDispatcher(scratchDispatcher);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain(`workdir=${join(realProjectRoot, "platform", "billing")}`);
	});

	guarded("accepts a .git file, as used by worktrees and submodules", () => {
		const { projectRoot, realProjectRoot, scratchDispatcher } = makeProject("repo: payments-api\n");
		mkdirSync(join(projectRoot, "payments-api"), { recursive: true });
		writeFileSync(join(projectRoot, "payments-api", ".git"), "gitdir: ../.git/worktrees/payments-api\n");
		const result = runDispatcher(scratchDispatcher);
		expect(result.stdout).toContain(`workdir=${join(realProjectRoot, "payments-api")}`);
	});

	guarded("rejects a repo that does not exist", () => {
		const { scratchDispatcher } = makeProject("repo: nope\n");
		const result = runDispatcher(scratchDispatcher);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("cannot be used");
		expect(result.stdout).toContain("no such directory");
	});

	guarded("rejects a directory that is not a git repository", () => {
		const { projectRoot, scratchDispatcher } = makeProject("repo: not-a-repo\n");
		mkdirSync(join(projectRoot, "not-a-repo"), { recursive: true });
		const result = runDispatcher(scratchDispatcher);
		expect(result.stdout).toContain("not a git repository");
	});

	guarded("rejects a traversal that escapes the project root", () => {
		// ../outside exists AND is a git repo, so only the containment check
		// can be what rejects it.
		const { scratchDispatcher } = makeProject("repo: ../outside\n");
		const result = runDispatcher(scratchDispatcher);
		expect(result.stdout).toContain("resolves outside the project root");
	});

	guarded("rejects an absolute path", () => {
		const { scratchDispatcher } = makeProject("repo: /tmp\n");
		const result = runDispatcher(scratchDispatcher);
		expect(result.stdout).toContain("absolute paths are not allowed");
	});

	guarded("never launches an agent for an unusable repo", () => {
		const { promptsDir, scratchDispatcher } = makeProject("repo: nope\n");
		// Not a dry run: the rejection must stop the dispatch on its own. The
		// `backlog` CLI is absent here, so the Blocked move degrades to a
		// message rather than a crash — and crucially no agent is spawned.
		const result = runDispatcher(scratchDispatcher, {}, { dryRun: false });
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("cannot be used");
		// A launched agent would have written a .log; only the .prompt exists.
		const logs = readdirSync(join(promptsDir, "logs"));
		expect(logs.some((f) => f.endsWith(".log"))).toBe(false);
	});

	guarded("does not consume a hop claim when the repo is unusable", () => {
		const { promptsDir, scratchDispatcher } = makeProject("repo: nope\n");
		runDispatcher(scratchDispatcher, {}, { dryRun: false });
		// Hop claims count coder/reviewer disagreement, not misconfiguration.
		const logs = readdirSync(join(promptsDir, "logs"));
		expect(logs.some((f) => f.includes(".hop-"))).toBe(false);
	});
});

describe("dispatch.sh — the fallback lookup cannot select a neighbouring task", () => {
	guarded("ignores a substring match whose frontmatter id is a different task", () => {
		// The anchored pattern misses "BACK-12 notes.md" (no " - " after the id),
		// so the loose fallback runs and matches it for BACK-1. Without the id
		// check that would hand BACK-12's repo to BACK-1's agent.
		scratchBase = mkdtempSync(join(tmpdir(), "backlog-dispatch-sh-"));
		const projectRoot = join(scratchBase, "project");
		const promptsDir = join(projectRoot, "backlog", "prompts");
		const tasksDir = join(projectRoot, "backlog", "tasks");
		mkdirSync(join(promptsDir, "logs"), { recursive: true });
		mkdirSync(tasksDir, { recursive: true });
		mkdirSync(join(projectRoot, "wrong-repo", ".git"), { recursive: true });
		writeFileSync(join(promptsDir, "dispatch.sh"), readFileSync(dispatcherPath, "utf8"), { mode: 0o755 });
		writeFileSync(join(promptsDir, "code.md"), "Coder prompt body.\n");
		writeFileSync(
			join(tasksDir, "BACK-12 notes.md"),
			"---\nid: BACK-12\ntitle: Other task\nstatus: To Do\nassignee: []\ncreated_date: '2026-01-01'\nlabels: []\ndependencies: []\nagent: claude\nrepo: wrong-repo\n---\n",
		);

		const result = runDispatcher(join(promptsDir, "dispatch.sh"));
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("its id (BACK-12) is not BACK-1");
		// Falls back to the project root rather than BACK-12's repository.
		// Unresolved here, not `realpathSync`: with no repo the dispatcher keeps
		// the project root exactly as it derived it, and only resolves a path it
		// has to containment-check.
		expect(result.stdout).toContain(`workdir=${projectRoot}`);
		expect(result.stdout).not.toContain("wrong-repo");
	});

	guarded("still resolves normally when the matched file's id agrees", () => {
		const { projectRoot, realProjectRoot, scratchDispatcher } = makeProject("repo: payments-api\n");
		mkdirSync(join(projectRoot, "payments-api", ".git"), { recursive: true });
		const result = runDispatcher(scratchDispatcher);
		expect(result.stdout).toContain(`workdir=${join(realProjectRoot, "payments-api")}`);
		expect(result.stdout).not.toContain("ignoring");
	});
});

describe("dispatch.sh — symlinked repositories", () => {
	guarded("rejects a symlink inside the project root that points outside it", () => {
		// The POSIX dispatcher resolves links with `pwd -P` before the
		// containment check, so the link's target is what gets judged. The
		// Windows dispatcher cannot resolve them on PowerShell 5.1 and refuses
		// to traverse one instead.
		const { projectRoot, scratchDispatcher } = makeProject("repo: escape\n");
		symlinkSync(join(String(scratchBase), "outside"), join(projectRoot, "escape"), "dir");
		const result = runDispatcher(scratchDispatcher);
		expect(result.stdout).toContain("resolves outside the project root");
	});

	guarded("accepts a symlink that stays inside the project root", () => {
		const { projectRoot, realProjectRoot, scratchDispatcher } = makeProject("repo: alias\n");
		mkdirSync(join(projectRoot, "payments-api", ".git"), { recursive: true });
		symlinkSync(join(projectRoot, "payments-api"), join(projectRoot, "alias"), "dir");
		const result = runDispatcher(scratchDispatcher);
		expect(result.stdout).toContain(`workdir=${join(realProjectRoot, "payments-api")}`);
	});
});

describe("dispatch.sh — runs under a strict POSIX shell", () => {
	// /bin/sh is dash on Debian and Ubuntu but bash on macOS, so a bashism is
	// invisible locally and only shows up on Linux. It has bitten this script
	// once already: `${BASH_SOURCE[0]}` raised "Bad substitution" under dash,
	// which left script_dir empty, pointed project_root somewhere else, and
	// made the dispatcher exit 0 having silently done nothing — the whole loop
	// dead on Ubuntu with no error anyone would notice.
	const dash = Bun.which("dash");
	const dashTest = shouldRun && dash ? test : test.skip;

	dashTest("resolves the repo identically under dash", () => {
		const { projectRoot, realProjectRoot, promptsDir } = makeProject("repo: payments-api\n");
		mkdirSync(join(projectRoot, "payments-api", ".git"), { recursive: true });
		const result = spawnSync(String(dash), [join(promptsDir, "dispatch.sh")], {
			encoding: "utf8",
			env: {
				...process.env,
				TASK_ID: "BACK-1",
				TASK_TITLE: "Sample task",
				OLD_STATUS: "To Do",
				NEW_STATUS: "In Progress",
				BACKLOG_DISPATCH_DRY_RUN: "1",
			},
		});
		expect(result.status).toBe(0);
		expect(result.stderr).not.toContain("Bad substitution");
		expect(result.stdout).toContain(`workdir=${join(realProjectRoot, "payments-api")}`);
	});
});

describe("dispatch.sh — tasks with no agent", () => {
	guarded("exits cleanly and launches nothing for a human task", () => {
		// Regression: `set -o pipefail` plus a non-matching `grep '^agent:'`
		// aborted the script with status 1 before it could reach the "human
		// task, do not dispatch" check, so every such transition was reported
		// as a failed status-change callback.
		scratchBase = mkdtempSync(join(tmpdir(), "backlog-dispatch-sh-"));
		const projectRoot = join(scratchBase, "project");
		const promptsDir = join(projectRoot, "backlog", "prompts");
		const tasksDir = join(projectRoot, "backlog", "tasks");
		mkdirSync(join(promptsDir, "logs"), { recursive: true });
		mkdirSync(tasksDir, { recursive: true });
		writeFileSync(join(promptsDir, "dispatch.sh"), readFileSync(dispatcherPath, "utf8"), { mode: 0o755 });
		writeFileSync(join(promptsDir, "code.md"), "Coder prompt body.\n");
		writeFileSync(
			join(tasksDir, "back-1 - Human-task.md"),
			"---\nid: BACK-1\ntitle: Human task\nstatus: In Progress\nassignee: []\ncreated_date: '2026-01-01'\nlabels: []\ndependencies: []\n---\n",
		);

		const result = runDispatcher(join(promptsDir, "dispatch.sh"), {}, { dryRun: false });
		expect(result.status).toBe(0);
		const logs = readdirSync(join(promptsDir, "logs"));
		expect(logs.some((f) => f.endsWith(".log"))).toBe(false);
	});
});

describe("dispatch.sh — prompt context", () => {
	guarded("appends a Repository line when the task names a repo", () => {
		const { projectRoot, promptsDir, scratchDispatcher } = makeProject("repo: payments-api\n");
		mkdirSync(join(projectRoot, "payments-api", ".git"), { recursive: true });
		runDispatcher(scratchDispatcher);
		const prompt = readPromptFile(promptsDir);
		expect(prompt).toContain("Coder prompt body.");
		expect(prompt).toContain("Repository: payments-api");
	});

	guarded("leaves the context block untouched for a task with no repo", () => {
		const { promptsDir, scratchDispatcher } = makeProject();
		runDispatcher(scratchDispatcher);
		const prompt = readPromptFile(promptsDir);
		expect(prompt).toContain("Task: BACK-1 — Sample task");
		expect(prompt).not.toContain("Repository:");
	});
});

describe("dispatch.sh — task file lookup", () => {
	guarded("matches the task file case-insensitively despite the uppercase id", () => {
		// id BACK-1 vs filename "back-1 - Sample-task.md".
		const { projectRoot, scratchDispatcher } = makeProject("repo: payments-api\n");
		mkdirSync(join(projectRoot, "payments-api", ".git"), { recursive: true });
		const result = runDispatcher(scratchDispatcher);
		expect(result.stdout).toContain("(repo: payments-api)");
	});

	guarded("does not pick a longer id that merely contains the requested one", () => {
		// BACK-1 must not resolve to back-12's frontmatter.
		const { projectRoot, tasksDir, scratchDispatcher } = makeProject("repo: payments-api\n");
		mkdirSync(join(projectRoot, "payments-api", ".git"), { recursive: true });
		mkdirSync(join(projectRoot, "wrong-repo", ".git"), { recursive: true });
		writeFileSync(
			join(tasksDir, "back-12 - Other-task.md"),
			"---\nid: BACK-12\ntitle: Other task\nstatus: To Do\nassignee: []\ncreated_date: '2026-01-01'\nlabels: []\ndependencies: []\nrepo: wrong-repo\n---\n",
		);
		const result = runDispatcher(scratchDispatcher);
		expect(result.stdout).toContain("(repo: payments-api)");
		expect(result.stdout).not.toContain("wrong-repo");
	});
});
