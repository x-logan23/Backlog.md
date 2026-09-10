import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { Core } from "../core/backlog.ts";
import { createUniqueTestDir, initializeTestProject, safeCleanup } from "./test-utils.ts";

// The dispatch loop reads `agent:`/`reviewAgent:` from a task's frontmatter to
// decide which CLI to launch as coder and reviewer. The MCP tools and the web UI
// could both set them; the CLI could not, so any task created from a terminal
// arrived with no agent and never dispatched.

let TEST_DIR: string;
const CLI_PATH = join(process.cwd(), "src", "cli.ts");

async function frontmatterOf(core: Core, id: string) {
	const task = await core.filesystem.loadTask(id);
	if (!task) throw new Error(`task ${id} not found`);
	return task;
}

describe("task create/edit agent flags", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-agent-flags");
		await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
		await mkdir(TEST_DIR, { recursive: true });

		await $`git init -b main`.cwd(TEST_DIR).quiet();
		await $`git config user.name "Test User"`.cwd(TEST_DIR).quiet();
		await $`git config user.email test@example.com`.cwd(TEST_DIR).quiet();

		const core = new Core(TEST_DIR);
		await initializeTestProject(core, "Agent Flags Test Project");
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// ignore
		}
	});

	it("records both agents given on create", async () => {
		const r = await $`bun ${CLI_PATH} task create "Coded" --agent claude --review-agent codex`
			.cwd(TEST_DIR)
			.quiet();
		expect(r.exitCode).toBe(0);

		const core = new Core(TEST_DIR);
		const task = await frontmatterOf(core, "TASK-1");
		expect(task.agent).toBe("claude");
		expect(task.reviewAgent).toBe("codex");
	});

	it("leaves both unset when the flags are omitted", async () => {
		// A task with no agent is a human task -- the dispatcher skips it -- so the
		// flags must stay strictly opt-in.
		const r = await $`bun ${CLI_PATH} task create "Plain"`.cwd(TEST_DIR).quiet();
		expect(r.exitCode).toBe(0);

		const core = new Core(TEST_DIR);
		const task = await frontmatterOf(core, "TASK-1");
		expect(task.agent).toBeUndefined();
		expect(task.reviewAgent).toBeUndefined();
	});

	it("changes an agent on edit", async () => {
		await $`bun ${CLI_PATH} task create "Coded" --agent claude --review-agent codex`.cwd(TEST_DIR).quiet();
		const r = await $`bun ${CLI_PATH} task edit TASK-1 --agent opencode`.cwd(TEST_DIR).quiet();
		expect(r.exitCode).toBe(0);

		const core = new Core(TEST_DIR);
		const task = await frontmatterOf(core, "TASK-1");
		expect(task.agent).toBe("opencode");
		expect(task.reviewAgent).toBe("codex");
	});

	it("clears an agent when passed an empty string", async () => {
		// Empty string is the documented "clear this field" signal, shared with the
		// MCP tools. It has to survive the CLI's own option handling, which is why
		// the wiring tests for `!== undefined` rather than truthiness.
		await $`bun ${CLI_PATH} task create "Coded" --agent claude --review-agent codex`.cwd(TEST_DIR).quiet();
		const r = await $`bun ${CLI_PATH} task edit TASK-1 --review-agent ${""}`.cwd(TEST_DIR).quiet();
		expect(r.exitCode).toBe(0);

		const core = new Core(TEST_DIR);
		const task = await frontmatterOf(core, "TASK-1");
		expect(task.agent).toBe("claude");
		expect(task.reviewAgent).toBeUndefined();
	});

	it("leaves an unmentioned agent alone on edit", async () => {
		await $`bun ${CLI_PATH} task create "Coded" --agent claude --review-agent codex`.cwd(TEST_DIR).quiet();
		await $`bun ${CLI_PATH} task edit TASK-1 --title "Renamed"`.cwd(TEST_DIR).quiet();

		const core = new Core(TEST_DIR);
		const task = await frontmatterOf(core, "TASK-1");
		expect(task.title).toBe("Renamed");
		expect(task.agent).toBe("claude");
		expect(task.reviewAgent).toBe("codex");
	});
});
