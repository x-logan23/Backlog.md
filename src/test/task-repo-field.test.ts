import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { formatTaskPlainText } from "../formatters/task-plain-text.ts";
import { Core } from "../index.ts";
import { parseTask } from "../markdown/parser.ts";
import { serializeTask } from "../markdown/serializer.ts";
import type { Task } from "../types/index.ts";
import { createUniqueTestDir, initializeTestProject, safeCleanup } from "./test-utils.ts";

function buildTask(overrides: Partial<Task> = {}): Task {
	return {
		id: "task-1",
		title: "Sample",
		status: "To Do",
		assignee: [],
		createdDate: "2026-09-10",
		labels: [],
		dependencies: [],
		rawContent: "",
		...overrides,
	};
}

describe("task repo field", () => {
	describe("markdown round trip", () => {
		it("preserves a repo value through serialize -> parse", () => {
			const parsed = parseTask(serializeTask(buildTask({ repo: "payments-api" })));
			expect(parsed.repo).toBe("payments-api");
		});

		it("preserves a nested repo path", () => {
			const parsed = parseTask(serializeTask(buildTask({ repo: "platform/billing" })));
			expect(parsed.repo).toBe("platform/billing");
		});

		it("omits the frontmatter key entirely when no repo is set", () => {
			const content = serializeTask(buildTask());
			expect(content).not.toContain("repo:");
			expect(parseTask(content).repo).toBeUndefined();
		});

		it("parses an absent repo as undefined rather than an empty string", () => {
			const parsed = parseTask(serializeTask(buildTask({ repo: "" })));
			expect(parsed.repo).toBeUndefined();
		});
	});

	describe("plain text output", () => {
		it("shows the repo when set", () => {
			expect(formatTaskPlainText(buildTask({ repo: "payments-api" }))).toContain("Repo: payments-api");
		});

		it("omits the line when unset", () => {
			expect(formatTaskPlainText(buildTask())).not.toContain("Repo:");
		});
	});

	describe("core create/edit/filter", () => {
		let TEST_DIR: string;

		beforeEach(async () => {
			TEST_DIR = createUniqueTestDir("test-task-repo");
			await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
			await mkdir(TEST_DIR, { recursive: true });
			await $`git init`.cwd(TEST_DIR).quiet();
			await $`git config user.name "Test User"`.cwd(TEST_DIR).quiet();
			await $`git config user.email "test@example.com"`.cwd(TEST_DIR).quiet();
			const core = new Core(TEST_DIR);
			await initializeTestProject(core, "Repo Field Test Project");
		});

		afterEach(async () => {
			await safeCleanup(TEST_DIR).catch(() => {});
		});

		it("stores a trimmed repo on create", async () => {
			const core = new Core(TEST_DIR);
			const { task } = await core.createTaskFromInput({ title: "With repo", repo: "  payments-api  " });
			expect(task.repo).toBe("payments-api");

			const reloaded = await core.getTask(task.id);
			expect(reloaded?.repo).toBe("payments-api");
		});

		it("leaves the field absent when the repo is only whitespace", async () => {
			const core = new Core(TEST_DIR);
			const { task } = await core.createTaskFromInput({ title: "Blank repo", repo: "   " });
			expect(task.repo).toBeUndefined();
		});

		it("sets and then clears the repo through edit", async () => {
			const core = new Core(TEST_DIR);
			const { task } = await core.createTaskFromInput({ title: "Editable" });

			const withRepo = await core.editTask(task.id, { repo: "auth-service" });
			expect(withRepo.repo).toBe("auth-service");

			const cleared = await core.editTask(task.id, { repo: "" });
			expect(cleared.repo).toBeUndefined();

			// The key must be gone from disk, not persisted as an empty string.
			const content = await Bun.file(String(cleared.filePath)).text();
			expect(content).not.toContain("repo:");
		});

		it("filters tasks by repo, ignoring case and trailing slashes", async () => {
			const core = new Core(TEST_DIR);
			await core.createTaskFromInput({ title: "A", repo: "payments-api" });
			await core.createTaskFromInput({ title: "B", repo: "auth-service" });
			await core.createTaskFromInput({ title: "C" });

			const exact = await core.queryTasks({ filters: { repo: "payments-api" } });
			expect(exact.map((t) => t.title)).toEqual(["A"]);

			const messy = await core.queryTasks({ filters: { repo: "Payments-API/" } });
			expect(messy.map((t) => t.title)).toEqual(["A"]);

			const none = await core.queryTasks({ filters: { repo: "does-not-exist" } });
			expect(none).toHaveLength(0);
		});
	});

	describe("CLI flags", () => {
		let TEST_DIR: string;
		const cliPath = join(process.cwd(), "src", "cli.ts");

		beforeEach(async () => {
			TEST_DIR = createUniqueTestDir("test-task-repo-cli");
			await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
			await mkdir(TEST_DIR, { recursive: true });
			await $`git init`.cwd(TEST_DIR).quiet();
			await $`git config user.name "Test User"`.cwd(TEST_DIR).quiet();
			await $`git config user.email "test@example.com"`.cwd(TEST_DIR).quiet();
			const core = new Core(TEST_DIR);
			await initializeTestProject(core, "Repo Field CLI Project");
		});

		afterEach(async () => {
			await safeCleanup(TEST_DIR).catch(() => {});
		});

		it("creates with --repo, filters with list --repo, and clears with an empty --repo", async () => {
			await $`bun ${[cliPath, "task", "create", "Ship it", "--repo", "payments-api"]}`.cwd(TEST_DIR).quiet();
			await $`bun ${[cliPath, "task", "create", "Other thing", "--repo", "auth-service"]}`.cwd(TEST_DIR).quiet();

			const listed = await $`bun ${[cliPath, "task", "list", "--repo", "payments-api", "--plain"]}`
				.cwd(TEST_DIR)
				.quiet();
			const listOutput = listed.stdout.toString();
			expect(listOutput).toContain("Ship it");
			expect(listOutput).not.toContain("Other thing");

			const core = new Core(TEST_DIR);
			const created = (await core.queryTasks({ filters: { repo: "payments-api" } }))[0];
			expect(created?.repo).toBe("payments-api");

			await $`bun ${[cliPath, "task", "edit", String(created?.id), "--repo", ""]}`.cwd(TEST_DIR).quiet();
			const afterClear = await new Core(TEST_DIR).getTask(String(created?.id));
			expect(afterClear?.repo).toBeUndefined();
		});
	});
});
