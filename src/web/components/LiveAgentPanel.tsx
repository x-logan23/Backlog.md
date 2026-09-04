import React, { useEffect, useRef, useState } from 'react';
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

/**
 * Events render as a label line above a full-width detail line rather than as
 * two columns. The label column was a fixed 6rem: mostly empty for `shell`,
 * still too narrow for `backlog.get_backlog_instructions`, and it cost every
 * detail line that width — the one thing in the pane actually worth reading.
 *
 * The label carries the semantic colour (it says what KIND of thing happened);
 * the detail stays in a calm body colour so a wall of output is readable, with
 * errors the deliberate exception.
 */
const LABEL_STYLES: Record<AgentEvent['kind'], string> = {
	tool: 'text-sky-600 dark:text-sky-400',
	message: 'text-gray-400 dark:text-gray-500',
	result: 'text-gray-400 dark:text-gray-600',
	error: 'text-red-600 dark:text-red-400',
	system: 'text-gray-400 dark:text-gray-600',
};

const DETAIL_STYLES: Record<AgentEvent['kind'], string> = {
	tool: 'text-gray-700 dark:text-gray-200',
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

/** Distance from the bottom still treated as "pinned", in px. */
const AT_BOTTOM_SLACK = 24;

const AgentPane: React.FC<{
	activity: AgentActivity;
	now: number;
	autoScroll: boolean;
	/** Called when the reader scrolls this pane away from the newest event. */
	onScrolledAway: () => void;
}> = ({ activity, now, autoScroll, onScrolledAway }) => {
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

	const scrollRef = useRef<HTMLDivElement>(null);

	// Re-pin whenever the newest event changes. Keyed on the last event's identity
	// rather than on events.length, because the feed is a ring buffer: once a pane
	// reaches its cap the length stops changing while the content keeps moving.
	const last = events[events.length - 1];
	const newestKey = `${events.length}|${last?.at ?? ''}|${last?.label ?? ''}|${last?.detail ?? ''}`;

	useEffect(() => {
		if (!autoScroll) return;
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [autoScroll, newestKey]);

	// Turning autoscroll off is the reader's decision, so infer it from where they
	// left the viewport rather than from the scroll event itself: our own
	// scroll-to-bottom fires this handler too, and a naive "any scroll disables it"
	// would switch the checkbox off the instant a new event arrived. Landing at the
	// bottom — however we got there — is never a reason to disengage.
	const handleScroll = () => {
		if (!autoScroll) return;
		const el = scrollRef.current;
		if (!el) return;
		const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_SLACK;
		if (!atBottom) onScrolledAway();
	};

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

			{/* Event stream — newest last, matching how a terminal reads. Taller than
			    the old two-column layout needed, because stacking the label costs a
			    line per event and roughly the same number should stay visible. */}
			<div
				ref={scrollRef}
				onScroll={handleScroll}
				className="flex-1 min-h-0 max-h-72 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-relaxed"
			>
				{events.length === 0 ? (
					<div className="text-gray-400 dark:text-gray-600">(no output yet)</div>
				) : (
					events.map((event, index) => {
						// A run of the same kind of event reads as one block: repeating
						// "shell" above every command in a five-command sequence is noise,
						// and the label is only informative where it changes.
						const previous = events[index - 1];
						const startsRun = !previous || previous.label !== event.label || previous.kind !== event.kind;
						return (
							<div key={`${event.at ?? ''}-${index}`} className={startsRun && index > 0 ? 'pt-1.5' : undefined}>
								{startsRun && (
									<div className={`text-[10px] tracking-wide ${LABEL_STYLES[event.kind]}`}>{event.label}</div>
								)}
								<div className={`${DETAIL_STYLES[event.kind]} break-words whitespace-pre-wrap`}>
									{event.detail}
								</div>
							</div>
						);
					})
				)}
			</div>
		</div>
	);
};

const AUTOSCROLL_KEY = 'backlog.agents.autoscroll';

const LiveAgentPanel: React.FC = () => {
	const activity = useAgentActivity();
	const [collapsed, setCollapsed] = useState(false);
	const anyRunning = activity.some((entry) => entry.running);
	const now = useNow(activity.length > 0);

	// Defaults to on: a live feed you have to chase is worse than one you have to
	// pause. Persisted because re-ticking it on every reload is exactly the kind of
	// small tax that makes a panel annoying to leave open.
	const [autoScroll, setAutoScroll] = useState<boolean>(() => {
		try {
			return window.localStorage.getItem(AUTOSCROLL_KEY) !== 'false';
		} catch {
			return true;
		}
	});

	const changeAutoScroll = (next: boolean) => {
		setAutoScroll(next);
		try {
			window.localStorage.setItem(AUTOSCROLL_KEY, String(next));
		} catch {
			// Private window or blocked storage — the toggle still works this session.
		}
	};

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

				<label
					className="ml-auto flex items-center gap-1.5 text-[11px] text-gray-600 dark:text-gray-400 cursor-pointer select-none"
					title="Follow the newest output. Scrolling a pane up turns this off; tick it again to jump back to the end."
				>
					<input
						type="checkbox"
						checked={autoScroll}
						onChange={(event) => changeAutoScroll(event.target.checked)}
						className="w-3.5 h-3.5 rounded border-gray-300 dark:border-gray-600 accent-green-600 dark:accent-green-500 cursor-pointer"
					/>
					Auto-scroll
				</label>
			</div>

			{!collapsed && (
				<div className="grid gap-3 grid-cols-1 lg:grid-cols-2 xl:grid-cols-3">
					{activity.map((entry) => (
						<AgentPane
							key={`${entry.taskId}-${entry.status}`}
							activity={entry}
							now={now}
							autoScroll={autoScroll}
							onScrolledAway={() => changeAutoScroll(false)}
						/>
					))}
				</div>
			)}
		</div>
	);
};

export default LiveAgentPanel;
