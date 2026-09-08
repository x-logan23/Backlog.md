import { useEffect, useState } from 'react';

export interface AgentPhaseStatus {
	running: boolean;
	completed: boolean;
	/**
	 * The dispatch's pid is alive and the task has not moved on, but the log has
	 * been silent past the grace window — neither working nor cleanly finished.
	 * Usually a stranded session, sometimes just an OS-recycled pid.
	 */
	stranded: boolean;
}

export interface TaskAgentStatus {
	/** State of the coder agent (dispatched on "In Progress" transitions). */
	coder?: AgentPhaseStatus;
	/** State of the reviewer agent (dispatched on "In Review" transitions). */
	reviewer?: AgentPhaseStatus;
}

type StatusMap = Record<string, TaskAgentStatus>;

interface ApiEntry {
	taskId: string;
	status: string;
	running: boolean;
	completed: boolean;
	stranded?: boolean;
}

// Module-level singleton — one polling interval shared across all TaskCard instances.
let cache: StatusMap = {};
const listeners = new Set<() => void>();
let intervalId: ReturnType<typeof setInterval> | null = null;
let consumerCount = 0;

function notify() {
	listeners.forEach(fn => fn());
}

async function poll() {
	try {
		const res = await fetch('/api/agent-status');
		if (!res.ok) return;
		const data: ApiEntry[] = await res.json();
		const next: StatusMap = {};
		for (const item of data) {
			if (!next[item.taskId]) next[item.taskId] = {};
			const phase: AgentPhaseStatus = {
				running: item.running,
				completed: item.completed,
				stranded: item.stranded ?? false,
			};
			const entry = next[item.taskId];
			if (entry) {
				if (item.status === 'In Progress') {
					entry.coder = phase;
				} else if (item.status === 'In Review') {
					entry.reviewer = phase;
				}
			}
		}
		cache = next;
		notify();
	} catch {
		// network error — keep stale cache
	}
}

function startPolling() {
	poll();
	intervalId = setInterval(poll, 5000);
}

function stopPolling() {
	if (intervalId !== null) {
		clearInterval(intervalId);
		intervalId = null;
	}
}

export function useAgentStatus(taskId: string): TaskAgentStatus {
	const [status, setStatus] = useState<TaskAgentStatus>(() => cache[taskId] ?? {});

	useEffect(() => {
		consumerCount++;
		if (consumerCount === 1) startPolling();

		const update = () => setStatus(cache[taskId] ?? {});
		listeners.add(update);
		update(); // sync with cache in case it updated between render and effect

		return () => {
			listeners.delete(update);
			consumerCount--;
			if (consumerCount === 0) stopPolling();
		};
	}, [taskId]);

	return status;
}
