import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
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
 * rewrites the file on a slow interval with a fresh timestamp, and an acquirer
 * treats a live pid carrying an old timestamp as stale. This is a liveness
 * proof, not proper-lockfile's compromise heartbeat: a late beat invalidates
 * nothing, and the staleness window is four missed beats precisely so a busy or
 * idle event loop never loses a lock it still holds.
 *
 * A file with no timestamp at all was written by a build predating this, and is
 * honoured under the old pid-only rule — see the legacy branch in
 * `acquireWatcherLock` for why evicting those would be worse than the bug.
 *
 * Lock file: <backlogDir>/.locks/watcher.pid
 */

export interface WatcherLockHolder {
	release(): Promise<void>;
	/** Always false for the PID-based lock (no heartbeat to compromise). */
	isCompromised(): boolean;
}

/**
 * How often the holder rewrites the lock file with a fresh timestamp.
 *
 * Not a proper-lockfile-style compromise heartbeat — nothing is invalidated if
 * a beat is late. It only has to prove, cheaply, that *some* live process is
 * still holding this lock, which a recycled pid cannot fake.
 */
const HEARTBEAT_MS = 30_000;

/**
 * How long a lock's timestamp may go unrefreshed before another process may claim it.
 *
 * Four missed beats. Generous on purpose: the cost of waiting slightly too long
 * is one server briefly deferring dispatch, while the cost of being too eager is
 * two processes both firing onStatusChange.
 */
const DEFAULT_STALE_MS = 4 * HEARTBEAT_MS;

export interface AcquireWatcherLockOptions {
	/**
	 * How long a lock's heartbeat may go unrefreshed before it is considered
	 * stale, even when its pid appears alive.
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

/**
 * Lock file body.
 *
 * Line 1 is the pid and nothing else, so a build predating the heartbeat still
 * reads the right owner: its `parseInt(content.trim(), 10)` stops at the newline
 * and never sees the rest. Line 2 carries the heartbeat, whose ABSENCE is the
 * signal that a legacy writer owns this file.
 *
 * The timestamp lives in the content rather than being inferred from mtime
 * because mtime is also what a backup, a sync client, or a `touch` would move.
 */
const HEARTBEAT_PREFIX = "hb=";

const formatLockFile = (pid: number): string => `${pid}\n${HEARTBEAT_PREFIX}${Date.now()}\n`;

export function parseLockFile(content: string): { pid: number | null; heartbeatAt: number | null } {
	const [pidLine, ...rest] = content.split("\n");
	const pid = Number.parseInt((pidLine ?? "").trim(), 10);
	let heartbeatAt: number | null = null;
	for (const line of rest) {
		const trimmed = line.trim();
		if (!trimmed.startsWith(HEARTBEAT_PREFIX)) continue;
		const parsed = Number.parseInt(trimmed.slice(HEARTBEAT_PREFIX.length), 10);
		if (Number.isFinite(parsed)) heartbeatAt = parsed;
	}
	return { pid: Number.isNaN(pid) ? null : pid, heartbeatAt };
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
	// AND its heartbeat is recent — a live pid behind an old timestamp is a
	// recycled pid, not a holder. (Legacy files carry no timestamp; see below.)
	try {
		const content = await readFile(pidFile, "utf8");
		const { pid: existingPid, heartbeatAt } = parseLockFile(content);
		if (existingPid !== null && isPidAlive(existingPid)) {
			if (heartbeatAt === null) {
				// Legacy lock file: written by a build that never heartbeats, so
				// its age says nothing about whether the holder is alive. Fall
				// back to the old pid-only rule and defer.
				//
				// This matters during an upgrade, not in theory. A server from
				// before this change writes the file once at startup; two of them
				// were found running with 15- and 17-day-old lock files. Applying
				// the staleness rule to those would evict a perfectly healthy
				// server and leave two processes both dispatching onStatusChange
				// — strictly worse than the stale-cache bug being fixed here.
				//
				// The cost is that a *killed* legacy holder still blocks forever;
				// deleting .locks/watcher.pid clears it, and the problem cannot
				// recur once every process writes the current format.
				return null;
			}
			if (staleMs <= 0 || Date.now() - heartbeatAt < staleMs) return null;
			// Stale heartbeat: the recorded pid belongs to something else now.
		}
		// PID is dead or its heartbeat went stale — we can take over.
	} catch {
		// File doesn't exist yet — no holder.
	}

	// Write our PID atomically (best-effort on Windows; good enough for a
	// single-machine process lock).
	try {
		await writeFile(pidFile, formatLockFile(process.pid), "utf8");
	} catch {
		return null;
	}

	// Verify we actually wrote our PID (guard against concurrent acquisition).
	try {
		const written = await readFile(pidFile, "utf8");
		if (parseLockFile(written).pid !== process.pid) {
			// Lost the race to another process.
			return null;
		}
	} catch {
		return null;
	}

	// Keep the timestamp moving so other processes can tell a real holder from a
	// recycled pid. unref() so this timer never keeps the process alive on its
	// own — a lock that outlives its usefulness is the bug above.
	const heartbeat = setInterval(() => {
		void writeFile(pidFile, formatLockFile(process.pid), "utf8").catch(() => {
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
				if (parseLockFile(content).pid === process.pid) {
					await unlink(pidFile);
				}
			} catch {
				// Already deleted or never existed — fine.
			}
		},
	};
}
