import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// create-mr.ps1 opens the GitLab MR when a task reaches Human Review. It must
// FAIL CLOSED: when the implementation branch cannot be resolved to exactly one
// candidate that belongs to this task, it must open nothing. A wrong MR is a
// path to merging unreviewed work; a missing one costs a human a minute.
//
// Each test runs the real script against a scratch project whose `origin` is a
// local bare repo, and against a mock GitLab API (GITLAB_API_URL) that records
// every request, so the assertions are on what the script actually sent.
const isWindows = process.platform === "win32";
const powershell = isWindows ? (Bun.which("powershell.exe") ?? Bun.which("powershell")) : null;
const shouldRun = isWindows && Boolean(powershell);
const guarded = shouldRun ? test : test.skip;

const repoRoot = resolve(import.meta.dir, "..", "..");
const scriptPath = join(repoRoot, "backlog", "prompts", "create-mr.ps1");
const PROJECT_ID = "4242";

type OpenMr = { iid: number; title: string; description: string; source_branch: string };
type RecordedRequest = { method: string; path: string; search: string; body: string };

let scratch: string | null = null;
let server: ReturnType<typeof Bun.serve> | null = null;

afterEach(() => {
	server?.stop(true);
	server = null;
	if (scratch) {
		try {
			rmSync(scratch, { recursive: true, force: true });
		} catch {}
		scratch = null;
	}
});

const git = (cwd: string, ...args: string[]) => {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
	return r.stdout;
};

/** A project with one commit, a bare `origin`, and the given branches pushed to it. */
const makeProject = (originBranches: string[]) => {
	scratch = mkdtempSync(join(tmpdir(), "backlog-create-mr-"));
	const projectRoot = join(scratch, "project");
	const origin = join(scratch, "origin.git");
	mkdirSync(join(projectRoot, "backlog", "tasks"), { recursive: true });
	git(scratch, "init", "-q", "--bare", origin);
	git(projectRoot, "init", "-q");
	git(projectRoot, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
	git(projectRoot, "remote", "add", "origin", origin);
	for (const branch of originBranches) {
		git(projectRoot, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
	}
	return projectRoot;
};

const writeTask = (projectRoot: string, id: string, title: string, notes = "") => {
	writeFileSync(
		join(projectRoot, "backlog", "tasks", `${id.toLowerCase()} - Task.md`),
		`---\nid: ${id}\ntitle: ${title}\nstatus: Human Review\n---\n\n## Description\n\nBody.\n\n## Implementation Notes\n\n${notes}\n`,
		"utf8",
	);
};

/** Mock GitLab merge_requests API. No MR exists unless `openMrs` says so. */
const startGitlab = (opts: { existingForBranch?: boolean; openMrs?: OpenMr[] } = {}) => {
	const requests: RecordedRequest[] = [];
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const body = req.method === "POST" ? new TextDecoder("utf-8").decode(await req.arrayBuffer()) : "";
			requests.push({ method: req.method, path: url.pathname, search: url.search, body });
			if (url.pathname !== `/api/v4/projects/${PROJECT_ID}/merge_requests`) {
				return new Response("not found", { status: 404 });
			}
			if (req.method === "POST") {
				return Response.json({ iid: 7, web_url: "http://gitlab.test/mr/7" }, { status: 201 });
			}
			if (url.searchParams.has("source_branch")) {
				const branch = url.searchParams.get("source_branch");
				return Response.json(opts.existingForBranch ? [{ iid: 3, state: "merged", source_branch: branch }] : []);
			}
			return Response.json(opts.openMrs ?? []);
		},
	});
	return { requests, apiUrl: `http://127.0.0.1:${server.port}/api/v4` };
};

/** Spawned async: a sync spawn would block the event loop the mock server runs on. */
const runScript = async (projectRoot: string, taskId: string, apiUrl: string, env: Record<string, string> = {}) => {
	const proc = Bun.spawn(
		[
			powershell as string,
			"-NoProfile",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			scriptPath,
			"-TaskId",
			taskId,
			"-ProjectRoot",
			projectRoot,
		],
		{
			env: {
				...process.env,
				GITLAB_PROJECT_ID: PROJECT_ID,
				GITLAB_TOKEN: "test-token",
				GITLAB_API_URL: apiUrl,
				GITLAB_TARGET_BRANCH: "",
				...env,
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	await proc.exited;
	return { stdout, stderr, exitCode: proc.exitCode };
};

const posts = (requests: RecordedRequest[]) => requests.filter((r) => r.method === "POST");

describe("create-mr.ps1 — fail-closed branch resolution", () => {
	guarded(
		"skips without touching the API when GITLAB_PROJECT_ID is unset",
		async () => {
			const projectRoot = makeProject(["feature/task-5-thing"]);
			writeTask(projectRoot, "TASK-5", "Thing");
			const { requests, apiUrl } = startGitlab();

			const r = await runScript(projectRoot, "TASK-5", apiUrl, { GITLAB_PROJECT_ID: "" });
			expect(r.stdout).toContain("GITLAB_PROJECT_ID not set");
			expect(requests).toHaveLength(0);
		},
		30000,
	);

	guarded(
		"a dotted subtask id resolves to its own branch, not a sibling's",
		async () => {
			// "TASK-587.3" used to collapse to "587" and match every feature/task-587-* branch.
			const projectRoot = makeProject([
				"feature/task-587-1-login",
				"feature/task-587-3-android-identity",
				"feature/task-587-31-unrelated",
			]);
			writeTask(projectRoot, "TASK-587.3", "Android identity");
			const { requests, apiUrl } = startGitlab();

			const r = await runScript(projectRoot, "TASK-587.3", apiUrl);
			const created = posts(requests);
			expect(created).toHaveLength(1);
			expect(JSON.parse(created[0]?.body ?? "{}").source_branch).toBe("feature/task-587-3-android-identity");
			expect(r.stdout).toContain("created MR !7");
		},
		30000,
	);

	guarded(
		"refuses when more than one origin branch could be this task's",
		async () => {
			const projectRoot = makeProject(["feature/task-12-first-try", "feature/task-12-second-try"]);
			writeTask(projectRoot, "TASK-12", "Twelve");
			const { requests, apiUrl } = startGitlab();

			const r = await runScript(projectRoot, "TASK-12", apiUrl);
			expect(r.stdout).toContain("AMBIGUOUS branch resolution for TASK-12");
			expect(r.stdout).toContain("feature/task-12-first-try");
			expect(r.stdout).toContain("feature/task-12-second-try");
			expect(requests).toHaveLength(0);
		},
		30000,
	);

	guarded(
		"a recorded Branch: line settles an otherwise ambiguous lookup (last one wins)",
		async () => {
			const projectRoot = makeProject(["feature/task-12-first-try", "feature/task-12-second-try"]);
			writeTask(
				projectRoot,
				"TASK-12",
				"Twelve",
				"Branch: feature/task-12-first-try\nReworked.\nBranch: feature/task-12-second-try",
			);
			const { requests, apiUrl } = startGitlab();

			await runScript(projectRoot, "TASK-12", apiUrl);
			const created = posts(requests);
			expect(created).toHaveLength(1);
			expect(JSON.parse(created[0]?.body ?? "{}").source_branch).toBe("feature/task-12-second-try");
		},
		30000,
	);

	guarded(
		"refuses a recorded branch that belongs to a different task",
		async () => {
			const projectRoot = makeProject(["feature/task-58-other"]);
			writeTask(projectRoot, "TASK-587", "Mine", "Branch: feature/task-58-other");
			const { requests, apiUrl } = startGitlab();

			const r = await runScript(projectRoot, "TASK-587", apiUrl);
			expect(r.stdout).toContain("REFUSING to create MR: branch 'feature/task-58-other' belongs to a different task");
			expect(requests).toHaveLength(0);
		},
		30000,
	);

	guarded(
		"skips when the resolved branch is not on origin",
		async () => {
			const projectRoot = makeProject([]);
			writeTask(projectRoot, "TASK-9", "Nine", "Branch: feature/task-9-local-only");
			const { requests, apiUrl } = startGitlab();

			const r = await runScript(projectRoot, "TASK-9", apiUrl);
			expect(r.stdout).toContain("not on origin");
			expect(requests).toHaveLength(0);
		},
		30000,
	);

	guarded(
		"skips when no branch can be found at all",
		async () => {
			const projectRoot = makeProject(["feature/task-10-something-else"]);
			writeTask(projectRoot, "TASK-9", "Nine");
			const { requests, apiUrl } = startGitlab();

			const r = await runScript(projectRoot, "TASK-9", apiUrl);
			expect(r.stdout).toContain("no implementation branch found for TASK-9");
			expect(requests).toHaveLength(0);
		},
		30000,
	);
});

describe("create-mr.ps1 — against the GitLab API", () => {
	guarded(
		"does nothing when an MR already exists for the branch",
		async () => {
			const projectRoot = makeProject(["feature/task-5-thing"]);
			writeTask(projectRoot, "TASK-5", "Thing");
			const { requests, apiUrl } = startGitlab({ existingForBranch: true });

			const r = await runScript(projectRoot, "TASK-5", apiUrl);
			expect(r.stdout).toContain("MR already exists for 'feature/task-5-thing' (!3, merged)");
			expect(posts(requests)).toHaveLength(0);
		},
		30000,
	);

	guarded(
		"refuses a second MR when an open one already claims the task from another branch",
		async () => {
			const projectRoot = makeProject(["feature/task-5-thing"]);
			writeTask(projectRoot, "TASK-5", "Thing");
			const { requests, apiUrl } = startGitlab({
				openMrs: [
					{ iid: 11, title: "Thing (TASK-5)", description: "Closes TASK-5", source_branch: "feature/task-5-older" },
				],
			});

			const r = await runScript(projectRoot, "TASK-5", apiUrl);
			expect(r.stdout).toContain("REFUSING to create MR: !11 already claims TASK-5");
			expect(posts(requests)).toHaveLength(0);
		},
		30000,
	);

	guarded(
		"sends a non-ASCII task title as UTF-8, without mojibake",
		async () => {
			// PS 5.1 reads BOM-less files and encodes string bodies as the ANSI codepage.
			const projectRoot = makeProject(["feature/task-5-cafe"]);
			writeTask(projectRoot, "TASK-5", "Añadir café — ñandú");
			const { requests, apiUrl } = startGitlab();

			await runScript(projectRoot, "TASK-5", apiUrl);
			const created = posts(requests);
			expect(created).toHaveLength(1);
			const body = JSON.parse(created[0]?.body ?? "{}");
			expect(body.title).toBe("Añadir café — ñandú (TASK-5)");
			expect(body.target_branch).toBe("main");
			expect(body.description).toContain("Closes TASK-5");
		},
		30000,
	);
});
