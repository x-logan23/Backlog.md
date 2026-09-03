import { useEffect, useState } from 'react';

/** One normalized event from an agent's feed. Mirrors core/agent-activity.ts. */
export interface AgentEvent {
	kind: 'message' | 'tool' | 'result' | 'error' | 'system';
	label: string;
	detail: string;
	at?: string;
}

export interface TokenTotals {
	input: number;
	output: number;
	cacheCreate: number;
	cacheRead: number;
	total: number;
}

export interface AgentActivity {
	taskId: string;
	taskTitle: string;
	status: string;
	phase: 'coder' | 'reviewer' | 'notifier';
	agentName: string;
	agentBinary: string;
	/** Corroborated liveness — a live pid alone is NOT enough (see isLikelyRunning). */
	running: boolean;
	/** Raw pid check. Exposed so "alive but silent" can be shown as the stranded tell. */
	pidAlive: boolean;
	/** Milliseconds since the feed last grew; null when the log is unreadable. */
	silentMs: number | null;
	startedAt: string | null;
	lastActivityAt: string | null;
	hop: number;
	maxHops: number;
	tokens: TokenTotals | null;
	/** Totals cover only the tail we parsed, not the whole session. */
	tokensPartial: boolean;
	events: AgentEvent[];
	sessionId: string | null;
	source: 'claude-transcript' | 'codex-json' | 'log-text';
	logFile: string;
}

// Module-level singleton: one interval regardless of how many components mount.
let cache: AgentActivity[] = [];
const listeners = new Set<() => void>();
let intervalId: ReturnType<typeof setInterval> | null = null;
let consumerCount = 0;

async function poll() {
	try {
		const res = await fetch('/api/agent-activity');
		if (!res.ok) return;
		cache = (await res.json()) as AgentActivity[];
		for (const fn of listeners) fn();
	} catch {
		// network blip — keep the last good snapshot rather than blanking the panel
	}
}

/**
 * Live activity for every agent the dispatcher currently has out.
 *
 * Polls every 3s: fast enough that a pane feels live, slow enough that the
 * server's incremental tail only re-parses a few KB per agent per tick.
 */
export function useAgentActivity(): AgentActivity[] {
	const [activity, setActivity] = useState<AgentActivity[]>(() => cache);

	useEffect(() => {
		consumerCount++;
		if (consumerCount === 1) {
			poll();
			intervalId = setInterval(poll, 3000);
		}

		const update = () => setActivity(cache);
		listeners.add(update);
		update(); // sync in case the cache moved between render and effect

		return () => {
			listeners.delete(update);
			consumerCount--;
			if (consumerCount === 0 && intervalId !== null) {
				clearInterval(intervalId);
				intervalId = null;
			}
		};
	}, []);

	return activity;
}
