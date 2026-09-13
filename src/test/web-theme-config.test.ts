import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FileSystem } from "../file-system/operations.ts";
import { BacklogServer } from "../server/index.ts";
import type { BacklogConfig } from "../types/index.ts";
import { createUniqueTestDir, retry, safeCleanup } from "./test-utils.ts";

const BASE_CONFIG: BacklogConfig = {
	projectName: "Theme Test",
	statuses: ["To Do", "In Progress", "Done"],
	labels: [],
	milestones: [],
	dateFormat: "YYYY-MM-DD",
	remoteOperations: false,
};

describe("theme config round trip", () => {
	let TEST_DIR: string;
	let filesystem: FileSystem;

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("theme-config");
		filesystem = new FileSystem(TEST_DIR);
		await filesystem.ensureBacklogStructure();
	});

	afterEach(async () => {
		await safeCleanup(TEST_DIR);
	});

	it("persists a theme name and reads it back", async () => {
		await filesystem.saveConfig({ ...BASE_CONFIG, theme: "midnight" });
		filesystem.invalidateConfigCache();
		expect((await filesystem.loadConfig())?.theme).toBe("midnight");
	});

	it("writes no theme key when none is set", async () => {
		await filesystem.saveConfig(BASE_CONFIG);
		const raw = await Bun.file(filesystem.configFilePath).text();
		expect(raw).not.toContain("theme:");
		filesystem.invalidateConfigCache();
		expect((await filesystem.loadConfig())?.theme).toBeUndefined();
	});

	it("survives an unrelated config rewrite", async () => {
		// The config writer serializes from the typed object, so a field that
		// round-trips only by luck would be dropped the first time anything
		// else is saved.
		await filesystem.saveConfig({ ...BASE_CONFIG, theme: "midnight" });
		filesystem.invalidateConfigCache();
		const loaded = await filesystem.loadConfig();
		await filesystem.saveConfig({ ...(loaded as BacklogConfig), maxColumnWidth: 25 });
		filesystem.invalidateConfigCache();
		expect((await filesystem.loadConfig())?.theme).toBe("midnight");
	});
});

describe("GET /theme.css", () => {
	let TEST_DIR: string;
	let filesystem: FileSystem;
	let server: BacklogServer | null = null;
	let serverPort = 0;

	const fetchTheme = async (timeoutMs = 1000): Promise<Response> => {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		try {
			return await fetch(`http://127.0.0.1:${serverPort}/theme.css`, { signal: controller.signal });
		} finally {
			clearTimeout(timeout);
		}
	};

	const startServer = async (config: BacklogConfig) => {
		await filesystem.saveConfig(config);
		filesystem.invalidateConfigCache();
		server = new BacklogServer(TEST_DIR);
		await server.start(0, false);
		serverPort = server.getPort() ?? 0;
		expect(serverPort).not.toBe(0);
		await retry(
			async () => {
				const res = await fetch(`http://127.0.0.1:${serverPort}/api/status`);
				if (!res.ok) throw new Error("server not ready");
				return true;
			},
			10,
			50,
		);
	};

	const writeTheme = async (name: string, css: string) => {
		const themesDir = join(dirname(filesystem.docsDir), "themes");
		await mkdir(themesDir, { recursive: true });
		await Bun.write(join(themesDir, `${name}.css`), css);
	};

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("theme-route");
		filesystem = new FileSystem(TEST_DIR);
		await filesystem.ensureBacklogStructure();
	});

	afterEach(async () => {
		if (server) {
			await server.stop();
			server = null;
		}
		await safeCleanup(TEST_DIR);
	});

	it("serves empty CSS when no theme is configured", async () => {
		await startServer(BASE_CONFIG);
		const res = await fetchTheme();
		// 200 rather than 404: an unthemed project is the normal case, and the
		// page requests this on every load.
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/css");
		expect(await res.text()).toBe("");
	});

	it("serves the configured theme file", async () => {
		await writeTheme("midnight", ":root{--color-blue-600:#0a3d62}");
		await startServer({ ...BASE_CONFIG, theme: "midnight" });
		const res = await fetchTheme();
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/css");
		expect(await res.text()).toBe(":root{--color-blue-600:#0a3d62}");
	});

	it("falls back to empty CSS when the configured theme file is missing", async () => {
		await startServer({ ...BASE_CONFIG, theme: "does-not-exist" });
		const res = await fetchTheme();
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("");
	});

	it("refuses a theme name containing a path separator", async () => {
		// A config value must not be able to name a file outside the themes
		// directory.
		await Bun.write(join(TEST_DIR, "escaped.css"), "body{display:none}");
		await startServer({ ...BASE_CONFIG, theme: "../../escaped" });
		const res = await fetchTheme();
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("");
	});

	it("is served with no-store headers so an edited palette shows on reload", async () => {
		await writeTheme("midnight", ":root{--color-gray-50:#fff}");
		await startServer({ ...BASE_CONFIG, theme: "midnight" });
		const res = await fetchTheme();
		expect(res.headers.get("cache-control")).toContain("no-store");
	});
});
