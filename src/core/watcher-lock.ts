import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Project-scoped watcher lock using a PID file instead of proper-lockfile's
 * mtime-based heartbeat. The heartbeat approach is unreliable on Windows:
 * the event loop is idle while an agent runs (minutes), the heartbeat timer
 * drifts, and proper-lockfile marks the lock as compromised.
 *
 * PID-based approach: write our PID to a file; any other acquirer checks
 * whether that PID is still alive.
 *
 * A live PID alone turned out not to be enough. Windows recycles process ids
 * aggressively and a force-killed server leaves its pid file behind, so once the
 * OS reassigns that number every later server sees a "live" holder and defers to
 * a process that no longer exists — permanently. The holder therefore also
 * refreshes the file's mtime on a slow interval, and an acquirer treats a live
 * pid on a long-untouched file as stale. This is a liveness proof, not
 * proper-lockfile's compromise heartbeat: a late beat invalidates nothing, and
 * the staleness window is four missed beats precisely so a busy or idle event
 * loop never loses a lock it still holds.
 *
 * Lock file: <backlogDir>/.locks/watcher.pid
 */

export interface WatcherLockHolder {
	release(): Promise<void>;
	/** Always false for the PID-based lock (no heartbeat to compromise). */
	isCompromised(): boolean;
}

/**
 * How often the holder refreshes the lock file's mtime.
 *
 * Not a proper-lockfile-style compromise heartbeat — nothing is invalidated if
 * a beat is late. It only has to prove, cheaply, that *some* live process is
 * still holding this lock, which a recycled pid cannot fake.
 */
const HEARTBEAT_MS = 30_000;

/**
 * How long the lock file may go untouched before another process may claim it.
 *
 * Four missed beats. Generous on purpose: the cost of waiting slightly too long
 * is one server briefly deferring dispatch, while the cost of being too eager is
 * two processes both firing onStatusChange.
 */
const DEFAULT_STALE_MS = 4 * HEARTBEAT_MS;

export interface AcquireWatcherLockOptions {
	/**
	 * How long the lock file may go untouched before it is considered stale,
	 * even when its pid appears alive.
	 *
	 * A live pid is NOT proof the original holder survives: Windows recycles
	 * pids aggressively, and a killed server leaves its pid file behind. Once
	 * the OS hands that number to an unrelated process, every later server
	 * reads a "live" pid and defers forever to a holder that no longer exists.
	 * Observed 2026-09-03 with a single bun process on the machine.
	 *
	 * Pass 0 to disable the staleness check and trust the pid alone.
	 */
	staleMs?: number;
}

const isPidAlive = (pid: number): boolean => {
	try {
		// signal 0 = check existence without sending a signal.
		// Throws ESRCH if the process doesn't exist; throws EPERM if it does
		// but we don't have permission (process IS alive). Returns true
		// otherwise.
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as { code?: string }).code;
		if (code === "ESRCH") return false;
		// EPERM means the process exists but we can't signal it — still alive.
		if (code === "EPERM") return true;
		return false;
	}
};

export async function acquireWatcherLock(
	backlogDir: string,
	options: AcquireWatcherLockOptions = {},
): Promise<WatcherLockHolder | null> {
	const locksDir = join(backlogDir, ".locks");
	const pidFile = join(locksDir, "watcher.pid");
	const staleMs = options.staleMs ?? DEFAULT_STALE_MS;

	await mkdir(locksDir, { recursive: true });

	// Check for an existing holder. It only blocks us if BOTH its pid resolves
	// AND it has refreshed the file recently — a live pid on a long-untouched
	// file is a recycled pid, not a holder.
	try {
		const content = await readFile(pidFile, "utf8");
		const existingPid = Number.parseInt(content.trim(), 10);
		if (!Number.isNaN(existingPid) && isPidAlive(existingPid)) {
			let heartbeatFresh = true;
			if (staleMs > 0) {
				try {
					const { mtimeMs } = await stat(pidFile);
					heartbeatFresh = Date.now() - mtimeMs < staleMs;
				} catch {
					// Cannot stat it — fall back to trusting the live pid.
				}
			}
			if (heartbeatFresh) return null;
			// Stale heartbeat: the recorded pid belongs to something else now.
		}
		// PID is dead or its heartbeat went stale — we can take over.
	} catch {
		// File doesn't exist yet — no holder.
	}

	// Write our PID atomically (best-effort on Windows; good enough for a
	// single-machine process lock).
	try {
		await writeFile(pidFile, String(process.pid), "utf8");
	} catch {
		return null;
	}

	// Verify we actually wrote our PID (guard against concurrent acquisition).
	try {
		const written = await readFile(pidFile, "utf8");
		if (Number.parseInt(written.trim(), 10) !== process.pid) {
			// Lost the race to another process.
			return null;
		}
	} catch {
		return null;
	}

	// Keep the file's mtime moving so other processes can tell a real holder
	// from a recycled pid. unref() so this timer never keeps the process alive
	// on its own — a lock that outlives its usefulness is the bug above.
	const heartbeat = setInterval(() => {
		void writeFile(pidFile, String(process.pid), "utf8").catch(() => {
			// Transient write failure: the next beat re-establishes freshness,
			// and a permanently failing one correctly reads as stale.
		});
	}, HEARTBEAT_MS);
	heartbeat.unref?.();

	return {
		isCompromised() {
			return false;
		},
		async release() {
			clearInterval(heartbeat);
			try {
				// Only delete if we still own it.
				const content = await readFile(pidFile, "utf8");
				if (Number.parseInt(content.trim(), 10) === process.pid) {
					await unlink(pidFile);
				}
			} catch {
				// Already deleted or never existed — fine.
			}
		},
	};
}
