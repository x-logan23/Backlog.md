import React, { useEffect, useState } from 'react';
import { type AgentActivity, type AgentEvent, useAgentActivity } from '../hooks/useAgentActivity';

/**
 * Board-level live view of every agent the dispatcher currently has out.
 *
 * The per-card log modal shows one task's raw output on demand; this answers the
 * question you actually have while the loop is running — "what is each agent
 * doing right now, and is any of them stuck?" — without opening anything.
 */

const AGENT_SILENT_WARN_MS = 5 * 60 * 1000;

function formatDuration(ms: number): string {
	if (ms < 1000) return '0s';
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	const h = Math.floor(m / 60);
	return `${h}h ${m % 60}m`;
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(n);
}

const EVENT_STYLES: Record<AgentEvent['kind'], string> = {
	tool: 'text-sky-700 dark:text-sky-300',
	message: 'text-gray-700 dark:text-gray-300',
	result: 'text-gray-500 dark:text-gray-500',
	error: 'text-red-600 dark:text-red-400',
	system: 'text-gray-400 dark:text-gray-500',
};

const SOURCE_LABEL: Record<AgentActivity['source'], string> = {
	'claude-transcript': 'transcript',
	'codex-json': 'json stream',
	'log-text': 'text log',
};

/** Live-updating elapsed clock so a pane's age advances between polls. */
function useNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, [active]);
	return now;
}

const AgentPane: React.FC<{ activity: AgentActivity; now: number }> = ({ activity, now }) => {
	const {
		taskId,
		taskTitle,
		status,
		phase,
		agentName,
		running,
		pidAlive,
		silentMs,
		startedAt,
		hop,
		maxHops,
		tokens,
		tokensPartial,
		events,
		source,
	} = activity;

	const elapsed = startedAt ? now - Date.parse(startedAt) : null;
	const quiet = silentMs !== null && silentMs > AGENT_SILENT_WARN_MS;
	// A live pid with a long-silent feed is the stranded-session signature — say so
	// rather than collapsing it into a plain "idle".
	const stranded = !running && pidAlive && quiet;
	const hopWarning = hop >= maxHops - 1;

	return (
		<div className="flex flex-col rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden">
			{/* Header */}
			<div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/80">
				{running ? (
					<span className="w-2 h-2 rounded-full bg-green-500 animate-pulse shrink-0" title="running" />
				) : stranded ? (
					<span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" title="process alive but no output" />
				) : (
					<span className="w-2 h-2 rounded-full bg-gray-400 dark:bg-gray-600 shrink-0" title="idle" />
				)}
				<span className="text-xs font-mono font-semibold text-gray-900 dark:text-gray-100 shrink-0">{taskId}</span>
				<span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 shrink-0">
					{status}
				</span>
				<span className="text-[11px] text-gray-500 dark:text-gray-400 truncate" title={taskTitle}>
					{taskTitle}
				</span>
				<span className="ml-auto text-[11px] text-gray-600 dark:text-gray-300 shrink-0">
					{agentName || 'unassigned'} <span className="text-gray-400 dark:text-gray-500">· {phase}</span>
				</span>
			</div>

			{/* Metrics */}
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-[10px] text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-700">
				{elapsed !== null && <span title="since dispatch">⏱ {formatDuration(elapsed)}</span>}
				{silentMs !== null && (
					<span className={quiet ? 'text-amber-600 dark:text-amber-400' : ''} title="since last output">
						last output {formatDuration(silentMs)} ago
					</span>
				)}
				{tokens && (
					<span title={`in ${tokens.input} · out ${tokens.output} · cache ${tokens.cacheRead + tokens.cacheCreate}`}>
						{formatTokens(tokens.input)} in / {formatTokens(tokens.output)} out /{' '}
						{formatTokens(tokens.cacheRead + tokens.cacheCreate)} cache
						{tokensPartial && <span className="text-gray-400"> (tail only)</span>}
					</span>
				)}
				<span className={hopWarning ? 'text-amber-600 dark:text-amber-400 font-medium' : ''} title="dispatcher loop guard">
					hop {hop}/{maxHops}
				</span>
				<span className="text-gray-400 dark:text-gray-600">{SOURCE_LABEL[source]}</span>
			</div>

			{stranded && (
				<div className="px-3 py-1.5 text-[10px] bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 border-b border-amber-100 dark:border-amber-900/40">
					Process alive but silent — likely stranded, or the pid was recycled by the OS.
				</div>
			)}

			{/* Event stream — newest last, matching how a terminal reads. */}
			<div className="flex-1 min-h-0 max-h-56 overflow-y-auto px-3 py-2 space-y-0.5 font-mono text-[11px] leading-relaxed">
				{events.length === 0 ? (
					<div className="text-gray-400 dark:text-gray-600">(no output yet)</div>
				) : (
					events.map((event, index) => (
						<div key={`${event.at ?? ''}-${index}`} className="flex gap-2">
							<span className="text-gray-400 dark:text-gray-600 shrink-0 w-24 truncate" title={event.label}>
								{event.label}
							</span>
							<span className={`${EVENT_STYLES[event.kind]} break-all`}>{event.detail}</span>
						</div>
					))
				)}
			</div>
		</div>
	);
};

const LiveAgentPanel: React.FC = () => {
	const activity = useAgentActivity();
	const [collapsed, setCollapsed] = useState(false);
	const anyRunning = activity.some((entry) => entry.running);
	const now = useNow(activity.length > 0);

	// Nothing dispatched: render nothing rather than an empty shell above the board.
	if (activity.length === 0) return null;

	const runningCount = activity.filter((entry) => entry.running).length;

	return (
		<div className="mb-6">
			<div className="flex items-center gap-2 mb-2">
				<button
					type="button"
					onClick={() => setCollapsed((value) => !value)}
					className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
					aria-expanded={!collapsed}
				>
					<span className={`transition-transform ${collapsed ? '' : 'rotate-90'}`}>▸</span>
					Agents
				</button>
				<span
					className={`text-[10px] px-1.5 py-0.5 rounded ${
						anyRunning
							? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300'
							: 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400'
					}`}
				>
					{runningCount} running
				</span>
				{activity.length > runningCount && (
					<span className="text-[10px] text-gray-400 dark:text-gray-500">
						{activity.length - runningCount} idle
					</span>
				)}
			</div>

			{!collapsed && (
				<div className="grid gap-3 grid-cols-1 lg:grid-cols-2 xl:grid-cols-3">
					{activity.map((entry) => (
						<AgentPane key={`${entry.taskId}-${entry.status}`} activity={entry} now={now} />
					))}
				</div>
			)}
		</div>
	);
};

export default LiveAgentPanel;
