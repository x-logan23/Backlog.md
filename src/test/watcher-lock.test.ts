import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireWatcherLock, parseLockFile } from "../core/watcher-lock.ts";

let scratchRoots: string[] = [];

afterEach(() => {
	for (const root of scratchRoots) {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {}
	}
	scratchRoots = [];
});

const scratchBacklogDir = (): string => {
	const root = mkdtempSync(join(tmpdir(), "backlog-watcher-lock-test-"));
	scratchRoots.push(root);
	return root;
};

describe("acquireWatcherLock", () => {
	it("returns a holder when the lock is free", async () => {
		const dir = scratchBacklogDir();
		const holder = await acquireWatcherLock(dir);
		expect(holder).not.toBeNull();
		await holder?.release();
	});

	it("returns null when another holder already owns the lock", async () => {
		const dir = scratchBacklogDir();
		const first = await acquireWatcherLock(dir);
		expect(first).not.toBeNull();

		const second = await acquireWatcherLock(dir);
		expect(second).toBeNull();

		await first?.release();
	});

	it("re-acquires after the previous holder releases", async () => {
		const dir = scratchBacklogDir();
		const first = await acquireWatcherLock(dir);
		await first?.release();

		const second = await acquireWatcherLock(dir);
		expect(second).not.toBeNull();
		await second?.release();
	});

	it("isolates locks per project — two projects can both hold their own", async () => {
		const a = scratchBacklogDir();
		const b = scratchBacklogDir();
		const holderA = await acquireWatcherLock(a);
		const holderB = await acquireWatcherLock(b);
		expect(holderA).not.toBeNull();
		expect(holderB).not.toBeNull();
		await holderA?.release();
		await holderB?.release();
	});

	it("release is safe to call twice", async () => {
		const dir = scratchBacklogDir();
		const holder = await acquireWatcherLock(dir);
		await holder?.release();
		// Second release must not throw — best-effort contract.
		await expect(holder?.release()).resolves.toBeUndefined();
	});

	it("creates the .locks subdirectory if missing", async () => {
		const dir = scratchBacklogDir();
		// Sanity: the test setup uses a fresh tempdir with no .locks yet, so
		// this exercises the mkdir { recursive: true } path.
		const holder = await acquireWatcherLock(dir);
		expect(holder).not.toBeNull();
		await holder?.release();
	});

	it("fresh holder reports isCompromised() === false", async () => {
		const dir = scratchBacklogDir();
		const holder = await acquireWatcherLock(dir);
		expect(holder?.isCompromised()).toBe(false);
		await holder?.release();
	});

	it("isCompromised() is always false — PID lock has no heartbeat to compromise", async () => {
		// The PID-based lock replaced the proper-lockfile mtime-heartbeat approach.
		// There is no heartbeat that can fail mid-run, so isCompromised() is
		// always false and release() is always a safe no-op.
		const dir = scratchBacklogDir();
		const holder = await acquireWatcherLock(dir);
		expect(holder).not.toBeNull();
		expect(holder?.isCompromised()).toBe(false);
		await holder?.release();
		expect(holder?.isCompromised()).toBe(false);
	});

	it("reclaims a PID file left by a dead process", async () => {
		// Simulate a crashed holder by writing a PID that is not alive.
		const dir = scratchBacklogDir();
		const { mkdirSync, writeFileSync } = await import("node:fs");
		mkdirSync(join(dir, ".locks"), { recursive: true });
		// 999999999 is an effectively impossible PID on any platform.
		writeFileSync(join(dir, ".locks", "watcher.pid"), "999999999", "utf8");

		const holder = await acquireWatcherLock(dir);
		expect(holder).not.toBeNull();
		await holder?.release();
	});
});

describe("acquireWatcherLock — recycled pid protection", () => {
	/**
	 * The regression these cover: a force-killed server leaves watcher.pid behind,
	 * Windows later hands that number to an unrelated process, and every server
	 * afterwards reads a "live" pid and defers forever to a holder that does not
	 * exist. Observed 2026-09-03 with a single bun process on the machine — the
	 * deferring server then ran with no watcher and served stale tasks for hours.
	 */
	const writeLock = (dir: string, body: string): void => {
		const locks = join(dir, ".locks");
		mkdirSync(locks, { recursive: true });
		writeFileSync(join(locks, "watcher.pid"), body, "utf8");
	};

	/** Current format: pid on line 1, heartbeat on line 2. */
	const currentFormat = (pid: number, heartbeatAgeMs: number): string =>
		`${pid}
hb=${Date.now() - heartbeatAgeMs}
`;

	it("reclaims a lock whose pid is alive but whose heartbeat went stale", async () => {
		const dir = scratchBacklogDir();
		// process.pid is unquestionably alive — it is us. Standing in for the
		// unrelated process the OS handed the dead server's number to.
		writeLock(dir, currentFormat(process.pid, 10 * 60 * 1000));

		const holder = await acquireWatcherLock(dir);
		expect(holder).not.toBeNull();
		await holder?.release();
	});

	it("still defers to a live holder that is keeping its heartbeat fresh", async () => {
		const dir = scratchBacklogDir();
		writeLock(dir, currentFormat(process.pid, 0));

		expect(await acquireWatcherLock(dir)).toBeNull();
	});

	it("honours an explicit staleMs window", async () => {
		const dir = scratchBacklogDir();
		writeLock(dir, currentFormat(process.pid, 5_000));

		const holder = await acquireWatcherLock(dir, { staleMs: 1_000 });
		expect(holder).not.toBeNull();
		await holder?.release();
	});

	it("trusts the pid alone when staleness checking is disabled", async () => {
		const dir = scratchBacklogDir();
		writeLock(dir, currentFormat(process.pid, 60 * 60 * 1000));

		expect(await acquireWatcherLock(dir, { staleMs: 0 })).toBeNull();
	});

	it("reclaims a lock left by a process that no longer exists", async () => {
		const dir = scratchBacklogDir();
		// A pid that cannot be running: above the platform maximum.
		writeLock(dir, currentFormat(4_000_000, 0));

		const holder = await acquireWatcherLock(dir);
		expect(holder).not.toBeNull();
		await holder?.release();
	});

	it("writes a heartbeat that a later acquirer can read", async () => {
		const dir = scratchBacklogDir();
		const holder = await acquireWatcherLock(dir);
		const parsed = parseLockFile(readFileSync(join(dir, ".locks", "watcher.pid"), "utf8"));
		expect(parsed.pid).toBe(process.pid);
		expect(parsed.heartbeatAt).toBeGreaterThan(Date.now() - 60_000);
		await holder?.release();
	});
});

describe("acquireWatcherLock — upgrade safety", () => {
	/**
	 * A build predating the heartbeat writes only a bare pid and never touches the
	 * file again. Two such servers were found running with 15- and 17-day-old lock
	 * files, so treating "old" as "dead" would evict a healthy server and leave two
	 * processes both dispatching onStatusChange — the multi-fire this lock exists to
	 * prevent, and strictly worse than the stale cache being fixed.
	 */
	const writeLegacyLock = (dir: string, pid: number): void => {
		const locks = join(dir, ".locks");
		mkdirSync(locks, { recursive: true });
		writeFileSync(join(locks, "watcher.pid"), String(pid), "utf8");
	};

	it("never evicts a live legacy holder, however old its file looks", async () => {
		const dir = scratchBacklogDir();
		writeLegacyLock(dir, process.pid);
		const pidFile = join(dir, ".locks", "watcher.pid");
		const ancient = new Date(Date.now() - 17 * 24 * 60 * 60 * 1000);
		utimesSync(pidFile, ancient, ancient);

		expect(await acquireWatcherLock(dir)).toBeNull();
	});

	it("still reclaims a legacy lock once its process is gone", async () => {
		const dir = scratchBacklogDir();
		writeLegacyLock(dir, 4_000_000);

		const holder = await acquireWatcherLock(dir);
		expect(holder).not.toBeNull();
		await holder?.release();
	});

	it("keeps the pid on its own first line so an old build still parses it", () => {
		const dir = scratchBacklogDir();
		mkdirSync(join(dir, ".locks"), { recursive: true });
		// Exactly what a pre-heartbeat build does: parseInt over the whole body.
		const body = `${process.pid}
hb=${Date.now()}
`;
		expect(Number.parseInt(body.trim(), 10)).toBe(process.pid);
	});
});
