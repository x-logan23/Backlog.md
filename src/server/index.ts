import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { $ } from "bun";
import {
	type AgentEvent,
	AgentFeedTail,
	claudeProjectSlug,
	deriveBadgeState,
	extractSessionIds,
	feedKindForBinary,
	type FeedKind,
	hopCount,
	isLikelyRunning,
	parseLogStem,
	safeSegment,
	type TokenTotals,
} from "../core/agent-activity.ts";
import { Core } from "../core/backlog.ts";
import type { ContentStore } from "../core/content-store.ts";
import { initializeProject } from "../core/init.ts";
import type { SearchService } from "../core/search-service.ts";
import { getTaskStatistics } from "../core/statistics.ts";
import { acquireWatcherLock, type WatcherLockHolder } from "../core/watcher-lock.ts";
import { isCreateLockError } from "../file-system/operations.ts";
import { BacklogToolError } from "../mcp/errors/mcp-errors.ts";
import { MilestoneHandlers } from "../mcp/tools/milestones/handlers.ts";
import {
	DOCUMENT_TYPE_VALUES,
	type Document,
	type SearchPriorityFilter,
	type SearchResultType,
	type Task,
	type TaskUpdateInput,
} from "../types/index.ts";
import { watchConfig } from "../utils/config-watcher.ts";
import { resolveMilestoneInputForStorage } from "../utils/milestone-storage.ts";
import { probeShellAvailability, resolveShellInvocation } from "../utils/status-callback.ts";
import { getVersion } from "../utils/version.ts";

/** Parse agent log output into readable text for the web UI log viewer. */
function agentLogParse(raw: string, isHumanReadable: boolean): string {
	if (!raw.trim()) return "";
	if (isHumanReadable) return raw; // .log.err already readable (Codex human-readable format)

	// Try JSON event stream (Codex --json mode or similar).
	const lines = raw.split("\n");
	const out: string[] = [];
	let anyJson = false;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const ev = JSON.parse(trimmed) as Record<string, unknown>;
			anyJson = true;
			const item = ev.item as Record<string, unknown> | undefined;
			if (ev.type === "item.completed" && item) {
				if (item.type === "agent_message" && typeof item.text === "string") {
					out.push(item.text.trim());
					out.push("");
				} else if (item.type === "command_execution") {
					// Strip the long powershell.exe path prefix for readability.
					const cmd = typeof item.command === "string"
						? item.command.replace(/^"[^"]*powershell[^"]*"\s+-\w+\s+/i, "").replace(/\\r\\n/g, "\n")
						: String(item.command ?? "");
					out.push(`$ ${cmd.trim()}`);
					const agg = typeof item.aggregated_output === "string" ? item.aggregated_output.trim() : "";
					if (agg) out.push(agg);
					out.push("");
				}
			} else if (ev.type === "turn.started") {
				// skip
			} else if (typeof ev.type === "string" && ev.type.startsWith("mcp")) {
				out.push(`[mcp] ${ev.type}`);
			}
		} catch {
			if (!anyJson) out.push(line); // plain text — Claude -p output
		}
	}

	return anyJson ? out.join("\n") : raw;
}

// Regex pattern to match any prefix (letters followed by dash)
const PREFIX_PATTERN = /^[a-zA-Z]+-/i;
const DEFAULT_PREFIX = "task-";
const DOCUMENT_TYPES = new Set<Document["type"]>(DOCUMENT_TYPE_VALUES);

class DocumentPayloadValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DocumentPayloadValidationError";
	}
}

function parseDocumentType(value: unknown): Document["type"] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new DocumentPayloadValidationError("Document type must be a string.");
	}
	if (!DOCUMENT_TYPES.has(value as Document["type"])) {
		throw new DocumentPayloadValidationError(`Document type must be one of: ${DOCUMENT_TYPE_VALUES.join(", ")}.`);
	}
	return value as Document["type"];
}

function parseDocumentTags(value: unknown): string[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		throw new DocumentPayloadValidationError("Document tags must be an array of strings.");
	}
	if (value.some((tag) => typeof tag !== "string")) {
		throw new DocumentPayloadValidationError("Document tags must be an array of strings.");
	}
	return Array.from(new Set(value.map((tag) => tag.trim()).filter((tag) => tag.length > 0)));
}

function parseCreateDocumentPath(value: unknown): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new DocumentPayloadValidationError("Document path must be a string.");
	}
	return value;
}

function parseUpdateDocumentPath(value: unknown): string | null | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === null || typeof value === "string") {
		return value;
	}
	throw new DocumentPayloadValidationError("Document path must be a string or null.");
}

function isDocumentValidationError(error: Error): boolean {
	return (
		error instanceof DocumentPayloadValidationError ||
		error.message.startsWith("Document type ") ||
		error.message.startsWith("Document path ") ||
		error.message === "Title is required to create a document." ||
		error.message === "Document title cannot be empty."
	);
}

/**
 * Strip any prefix from an ID (e.g., "task-123" -> "123", "JIRA-456" -> "456")
 */
function stripPrefix(id: string): string {
	return id.replace(PREFIX_PATTERN, "");
}

/**
 * Ensure an ID has a prefix. If it already has one, return as-is.
 * Otherwise, add the default "task-" prefix.
 */
function ensurePrefix(id: string): string {
	if (PREFIX_PATTERN.test(id)) {
		return id;
	}
	return `${DEFAULT_PREFIX}${id}`;
}

function parseTaskIdSegments(value: string): number[] | null {
	const withoutPrefix = stripPrefix(value);
	if (!/^[0-9]+(?:\.[0-9]+)*$/.test(withoutPrefix)) {
		return null;
	}
	return withoutPrefix.split(".").map((segment) => Number.parseInt(segment, 10));
}

function findTaskByLooseId(tasks: Task[], inputId: string): Task | undefined {
	// First try exact match (case-insensitive)
	const lowerInputId = inputId.toLowerCase();
	const exact = tasks.find((task) => task.id.toLowerCase() === lowerInputId);
	if (exact) {
		return exact;
	}

	// Try matching by numeric segments only
	const inputSegments = parseTaskIdSegments(inputId);
	if (!inputSegments) {
		return undefined;
	}

	return tasks.find((task) => {
		const candidateSegments = parseTaskIdSegments(task.id);
		if (!candidateSegments || candidateSegments.length !== inputSegments.length) {
			return false;
		}
		for (let index = 0; index < candidateSegments.length; index += 1) {
			if (candidateSegments[index] !== inputSegments[index]) {
				return false;
			}
		}
		return true;
	});
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}
	return undefined;
}

// @ts-expect-error
import favicon from "../web/favicon.png" with { type: "file" };
import indexHtml from "../web/index.html";

const NO_STORE_HEADERS = {
	"Cache-Control": "no-store, max-age=0, must-revalidate",
	Pragma: "no-cache",
	Expires: "0",
} as const;

function applyNoStoreHeaders(headers: Headers): void {
	for (const [name, value] of Object.entries(NO_STORE_HEADERS)) {
		headers.set(name, value);
	}
}

export function markHtmlBundleNoStore(bundle: Bun.HTMLBundle): Bun.HTMLBundle {
	if (!bundle.files) {
		return bundle;
	}

	for (const file of bundle.files) {
		if (file.loader === "html" && file.isEntry) {
			Object.assign(file.headers, NO_STORE_HEADERS);
		}
	}

	return bundle;
}

const spaIndexHtml = markHtmlBundleNoStore(indexHtml);

export class BacklogServer {
	private core: Core;
	private server: Server<unknown> | null = null;
	private projectName = "Untitled Project";
	private sockets = new Set<ServerWebSocket<unknown>>();
	private contentStore: ContentStore | null = null;
	private searchService: SearchService | null = null;
	private unsubscribeContentStore?: () => void;
	private storeReadyBroadcasted = false;
	private configWatcher: { stop: () => void } | null = null;
	private watcherLockHolder: WatcherLockHolder | null = null;
	/**
	 * Incremental tails for /api/agent-activity, keyed by absolute feed path.
	 *
	 * A coder's Claude transcript passes 10 MB within a session and the board
	 * polls every few seconds; without this the server would re-read and re-parse
	 * the whole file on every poll. Each entry remembers its byte offset, so a
	 * poll only parses what was appended since the last one.
	 */
	private agentFeeds = new Map<string, AgentFeedTail>();

	constructor(projectPath: string) {
		this.core = new Core(projectPath, { enableWatchers: true });
	}

	private async resolveMilestoneInput(milestone: string): Promise<string> {
		const [activeMilestones, archivedMilestones] = await Promise.all([
			this.core.filesystem.listMilestones(),
			this.core.filesystem.listArchivedMilestones(),
		]);
		return resolveMilestoneInputForStorage(milestone, activeMilestones, archivedMilestones);
	}

	private async ensureServicesReady(): Promise<void> {
		const store = await this.core.getContentStore();
		this.contentStore = store;

		if (!this.unsubscribeContentStore) {
			this.unsubscribeContentStore = store.subscribe((event) => {
				if (event.type === "ready") {
					if (!this.storeReadyBroadcasted) {
						this.storeReadyBroadcasted = true;
						return;
					}
					this.broadcastTasksUpdated();
					return;
				}

				// Broadcast for tasks/documents/decisions so clients refresh caches/search
				this.storeReadyBroadcasted = true;
				this.broadcastTasksUpdated();
			});
		}

		const search = await this.core.getSearchService();
		this.searchService = search;
	}

	private async getContentStoreInstance(): Promise<ContentStore> {
		await this.ensureServicesReady();
		if (!this.contentStore) {
			throw new Error("Content store not initialized");
		}
		return this.contentStore;
	}

	private async getSearchServiceInstance(): Promise<SearchService> {
		await this.ensureServicesReady();
		if (!this.searchService) {
			throw new Error("Search service not initialized");
		}
		return this.searchService;
	}

	getPort(): number | null {
		return this.server?.port ?? null;
	}

	private broadcastTasksUpdated() {
		for (const ws of this.sockets) {
			try {
				ws.send("tasks-updated");
			} catch {}
		}
	}

	private broadcastConfigUpdated() {
		for (const ws of this.sockets) {
			try {
				ws.send("config-updated");
			} catch {}
		}
	}

	async start(port?: number, openBrowser = true): Promise<void> {
		// Prevent duplicate starts (e.g., accidental re-entry)
		if (this.server) {
			console.log("Server already running");
			return;
		}
		// Load config (migration is handled globally by CLI)
		const config = await this.core.filesystem.loadConfig();

		// Use config default port if no port specified
		const finalPort = port ?? config?.defaultPort ?? 6420;
		this.projectName = config?.projectName || "Untitled Project";

		// Check if browser should open (config setting or CLI override)
		// Default to true if autoOpenBrowser is not explicitly set to false
		const shouldOpenBrowser = openBrowser && (config?.autoOpenBrowser ?? true);

		// Acquire the project-scoped watcher lock so multiple concurrent
		// Backlog.md processes for the same project don't all install their
		// own fs.watch handlers (which would multi-dispatch the onStatusChange
		// hook on every hand edit). If another process holds the lock, this
		// server still starts so its UI works — it just doesn't install its
		// own watcher; the lock holder drives hook dispatch for everyone.
		this.watcherLockHolder = await acquireWatcherLock(this.core.filesystem.backlogDir);
		if (this.watcherLockHolder) {
			// We're the authority — our watcher dispatches onStatusChange.
			this.core.setHookDispatchAuthority(true);
		} else {
			console.warn(
				"⚠️  Another Backlog.md process holds the watcher lock for this project. " +
					"File-watcher-driven onStatusChange dispatch will be handled by that process; " +
					"this server will respond to API/MCP requests but won't install its own watcher.",
			);
			this.core.setEnableWatchers(false);
			// Suppress in-process hook fires — the lock holder's watcher will
			// observe our writes and dispatch instead. Without this gate the
			// hook would fire twice (once here from dispatchInProcess, once
			// from the lock holder's watcher).
			this.core.setHookDispatchAuthority(false);
		}

		// Set up config watcher to broadcast changes
		this.configWatcher = watchConfig(this.core, {
			onConfigChanged: () => {
				this.broadcastConfigUpdated();
			},
		});

		try {
			await this.ensureServicesReady();
			const serveOptions = {
				port: finalPort,
				development: process.env.NODE_ENV === "development",
				routes: {
					"/": spaIndexHtml,
					"/tasks": spaIndexHtml,
					"/milestones": spaIndexHtml,
					"/drafts": spaIndexHtml,
					"/documentation": spaIndexHtml,
					"/documentation/*": spaIndexHtml,
					"/decisions": spaIndexHtml,
					"/decisions/*": spaIndexHtml,
					"/statistics": spaIndexHtml,
					"/settings": spaIndexHtml,

					// API Routes using Bun's native route syntax
					"/api/tasks": {
						GET: async (req: Request) => await this.handleListTasks(req),
						POST: async (req: Request) => await this.handleCreateTask(req),
					},
					"/api/task/:id": {
						GET: async (req: Request & { params: { id: string } }) => await this.handleGetTask(req.params.id),
					},
					"/api/tasks/:id": {
						GET: async (req: Request & { params: { id: string } }) => await this.handleGetTask(req.params.id),
						PUT: async (req: Request & { params: { id: string } }) => await this.handleUpdateTask(req, req.params.id),
						DELETE: async (req: Request & { params: { id: string } }) => await this.handleDeleteTask(req.params.id),
					},
					"/api/tasks/:id/complete": {
						POST: async (req: Request & { params: { id: string } }) => await this.handleCompleteTask(req.params.id),
					},
					"/api/statuses": {
						GET: async () => await this.handleGetStatuses(),
					},
					"/api/config": {
						GET: async () => await this.handleGetConfig(),
						PUT: async (req: Request) => await this.handleUpdateConfig(req),
					},
					"/api/docs": {
						GET: async () => await this.handleListDocs(),
						POST: async (req: Request) => await this.handleCreateDoc(req),
					},
					"/api/doc/:id": {
						GET: async (req: Request & { params: { id: string } }) => await this.handleGetDoc(req.params.id),
					},
					"/api/docs/:id": {
						GET: async (req: Request & { params: { id: string } }) => await this.handleGetDoc(req.params.id),
						PUT: async (req: Request & { params: { id: string } }) => await this.handleUpdateDoc(req, req.params.id),
					},
					"/api/decisions": {
						GET: async () => await this.handleListDecisions(),
						POST: async (req: Request) => await this.handleCreateDecision(req),
					},
					"/api/decision/:id": {
						GET: async (req: Request & { params: { id: string } }) => await this.handleGetDecision(req.params.id),
					},
					"/api/decisions/:id": {
						GET: async (req: Request & { params: { id: string } }) => await this.handleGetDecision(req.params.id),
						PUT: async (req: Request & { params: { id: string } }) =>
							await this.handleUpdateDecision(req, req.params.id),
					},
					"/api/drafts": {
						GET: async () => await this.handleListDrafts(),
					},
					"/api/drafts/:id/promote": {
						POST: async (req: Request & { params: { id: string } }) => await this.handlePromoteDraft(req.params.id),
					},
					"/api/milestones": {
						GET: async () => await this.handleListMilestones(),
						POST: async (req: Request) => await this.handleCreateMilestone(req),
					},
					"/api/milestones/archived": {
						GET: async () => await this.handleListArchivedMilestones(),
					},
					"/api/milestones/:id": {
						GET: async (req: Request & { params: { id: string } }) => await this.handleGetMilestone(req.params.id),
						PUT: async (req: Request & { params: { id: string } }) =>
							await this.handleUpdateMilestone(req, req.params.id),
						DELETE: async (req: Request & { params: { id: string } }) =>
							await this.handleRemoveMilestone(req, req.params.id),
					},
					"/api/milestones/:id/archive": {
						POST: async (req: Request & { params: { id: string } }) => await this.handleArchiveMilestone(req.params.id),
					},
					"/api/tasks/reorder": {
						POST: async (req: Request) => await this.handleReorderTask(req),
					},
					"/api/tasks/cleanup": {
						GET: async (req: Request) => await this.handleCleanupPreview(req),
					},
					"/api/tasks/cleanup/execute": {
						POST: async (req: Request) => await this.handleCleanupExecute(req),
					},
					"/api/version": {
						GET: async () => await this.handleGetVersion(),
					},
					"/api/statistics": {
						GET: async () => await this.handleGetStatistics(),
					},
					"/api/status": {
						GET: async () => await this.handleGetStatus(),
					},
					"/api/agent-status": {
						GET: async () => await this.handleGetAgentStatus(),
					},
					"/api/agent-log": {
						GET: async (req: Request) => await this.handleGetAgentLog(req),
					},
					"/api/agent-activity": {
						GET: async () => await this.handleGetAgentActivity(),
					},
					"/api/init": {
						POST: async (req: Request) => await this.handleInit(req),
					},
					"/api/search": {
						GET: async (req: Request) => await this.handleSearch(req),
					},
					"/sequences": {
						GET: async () => await this.handleGetSequences(),
					},
					"/sequences/move": {
						POST: async (req: Request) => await this.handleMoveSequence(req),
					},
					"/api/sequences": {
						GET: async () => await this.handleGetSequences(),
					},
					"/api/sequences/move": {
						POST: async (req: Request) => await this.handleMoveSequence(req),
					},
					// Serve files placed under backlog/assets at /assets/<relative-path>
					"/assets/*": {
						GET: async (req: Request) => await this.handleAssetRequest(req),
					},
				},
				fetch: async (req: Request, server: Server<unknown>) => {
					const res = await this.handleRequest(req, server);

					// Disable caching for GET/HEAD so browser always fetches latest content
					if (req.method === "GET" || req.method === "HEAD") {
						applyNoStoreHeaders(res.headers);
					}

					return res;
				},
				error: this.handleError.bind(this),
				websocket: {
					open: (ws: ServerWebSocket) => {
						this.sockets.add(ws);
					},
					message(ws: ServerWebSocket) {
						ws.send("pong");
					},
					close: (ws: ServerWebSocket) => {
						this.sockets.delete(ws);
					},
				},
				/* biome-ignore format: keep cast on single line below for type narrowing */
			};
			this.server = Bun.serve(serveOptions as unknown as Parameters<typeof Bun.serve>[0]);

			const url = `http://localhost:${finalPort}`;
			console.log(`🚀 Backlog.md browser interface running at ${url}`);
			console.log(`📊 Project: ${this.projectName}`);
			const stopKey = process.platform === "darwin" ? "Cmd+C" : "Ctrl+C";
			console.log(`⏹️  Press ${stopKey} to stop the server`);

			if (shouldOpenBrowser) {
				console.log("🌐 Opening browser...");
				await this.openBrowser(url);
			} else {
				console.log("💡 Open your browser and navigate to the URL above");
			}
		} catch (error) {
			// Handle port already in use error
			const errorCode = (error as { code?: string })?.code;
			const errorMessage = (error as Error)?.message;
			if (errorCode === "EADDRINUSE" || errorMessage?.includes("address already in use")) {
				console.error(`\n❌ Error: Port ${finalPort} is already in use.\n`);
				console.log("💡 Suggestions:");
				console.log(`   1. Try a different port: backlog browser --port ${finalPort + 1}`);
				console.log(`   2. Find what's using port ${finalPort}:`);
				if (process.platform === "darwin" || process.platform === "linux") {
					console.log(`      Run: lsof -i :${finalPort}`);
				} else if (process.platform === "win32") {
					console.log(`      Run: netstat -ano | findstr :${finalPort}`);
				}
				console.log("   3. Or kill the process using the port and try again\n");
				process.exit(1);
			}

			// Handle other errors
			console.error("❌ Failed to start server:", errorMessage || error);
			process.exit(1);
		}
	}

	private _stopping = false;

	async stop(): Promise<void> {
		if (this._stopping) return;
		this._stopping = true;

		// Stop filesystem watcher first to reduce churn
		try {
			this.unsubscribeContentStore?.();
			this.unsubscribeContentStore = undefined;
		} catch {}

		// Stop config watcher
		try {
			this.configWatcher?.stop();
			this.configWatcher = null;
		} catch {}

		this.core.disposeSearchService();
		this.core.disposeContentStore();
		this.searchService = null;
		this.contentStore = null;
		this.storeReadyBroadcasted = false;

		// Release the watcher lock so another process (e.g. a fresh `backlog
		// browser` started right after this one) can take ownership without
		// waiting for the stale-lock heartbeat to elapse.
		if (this.watcherLockHolder) {
			const holder = this.watcherLockHolder;
			this.watcherLockHolder = null;
			try {
				await holder.release();
			} catch {}
		}

		// Proactively close WebSocket connections
		for (const ws of this.sockets) {
			try {
				ws.close();
			} catch {}
		}
		this.sockets.clear();

		// Attempt to stop the server but don't hang forever
		if (this.server) {
			const serverRef = this.server;
			const stopPromise = (async () => {
				try {
					await serverRef.stop();
				} catch {}
			})();
			const timeout = new Promise<void>((resolve) => setTimeout(resolve, 1500));
			await Promise.race([stopPromise, timeout]);
			this.server = null;
			console.log("Server stopped");
		}

		this._stopping = false;
	}

	private async openBrowser(url: string): Promise<void> {
		try {
			const platform = process.platform;
			let cmd: string[];

			switch (platform) {
				case "darwin": // macOS
					cmd = ["open", url];
					break;
				case "win32": // Windows
					cmd = ["cmd", "/c", "start", "", url];
					break;
				default: // Linux and others
					cmd = ["xdg-open", url];
					break;
			}

			await $`${cmd}`.quiet();
		} catch (error) {
			console.warn("⚠️  Failed to open browser automatically:", error);
			console.log("💡 Please open your browser manually and navigate to the URL above");
		}
	}

	private async handleAssetRequest(req: Request): Promise<Response> {
		try {
			const url = new URL(req.url);
			const pathname = decodeURIComponent(url.pathname || "");
			const prefix = "/assets/";
			if (!pathname.startsWith(prefix)) return new Response("Not Found", { status: 404 });

			// Path relative to backlog/assets
			const relPath = pathname.slice(prefix.length);

			// disallow traversal
			if (relPath.includes("..")) return new Response("Not Found", { status: 404 });

			// derive backlog root from docsDir (parent of backlog/docs)
			const docsDir = this.core.filesystem.docsDir;
			const backlogRoot = dirname(docsDir);
			const assetsRoot = join(backlogRoot, "assets");
			const filePath = join(assetsRoot, relPath);

			if (!filePath.startsWith(assetsRoot)) return new Response("Not Found", { status: 404 });

			const file = Bun.file(filePath);
			if (!(await file.exists())) return new Response("Not Found", { status: 404 });

			const ext = (filePath.match(/\.([^./]+)$/) || [])[1]?.toLowerCase() || "";
			const mimeMap: Record<string, string> = {
				png: "image/png",
				jpg: "image/jpeg",
				jpeg: "image/jpeg",
				gif: "image/gif",
				svg: "image/svg+xml",
				webp: "image/webp",
				avif: "image/avif",
				pdf: "application/pdf",
				txt: "text/plain",
				css: "text/css",
				js: "application/javascript",
			};

			const mime = mimeMap[ext] ?? "application/octet-stream";
			return new Response(file, { headers: { "Content-Type": mime } });
		} catch (error) {
			console.error("Error serving asset:", error);
			return new Response("Internal Server Error", { status: 500 });
		}
	}

	private async handleRequest(req: Request, server: Server<unknown>): Promise<Response> {
		const url = new URL(req.url);
		const pathname = url.pathname;

		// Handle WebSocket upgrade
		if (req.headers.get("upgrade") === "websocket") {
			const success = server.upgrade(req, { data: undefined });
			if (success) {
				return new Response(null, { status: 101 }); // WebSocket upgrade response
			}
			return new Response("WebSocket upgrade failed", { status: 400 });
		}

		// Workaround as Bun doesn't support images imported from link tags in HTML
		if (pathname.startsWith("/favicon")) {
			const faviconFile = Bun.file(favicon);
			return new Response(faviconFile, {
				headers: { "Content-Type": "image/png" },
			});
		}

		// For all other routes, return 404 since routes should handle all valid paths
		return new Response("Not Found", { status: 404 });
	}

	// Task handlers
	private async handleListTasks(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const status = url.searchParams.get("status") || undefined;
		const assignee = url.searchParams.get("assignee") || undefined;
		const parent = url.searchParams.get("parent") || undefined;
		const priorityParam = url.searchParams.get("priority") || undefined;
		const crossBranch = url.searchParams.get("crossBranch") === "true";
		const labelParams = [...url.searchParams.getAll("label"), ...url.searchParams.getAll("labels")];
		const labelsCsv = url.searchParams.get("labels");
		if (labelsCsv) {
			labelParams.push(...labelsCsv.split(","));
		}
		const labels = labelParams.map((label) => label.trim()).filter((label) => label.length > 0);

		let priority: "high" | "medium" | "low" | undefined;
		if (priorityParam) {
			const normalizedPriority = priorityParam.toLowerCase();
			const allowed = ["high", "medium", "low"];
			if (!allowed.includes(normalizedPriority)) {
				return Response.json({ error: "Invalid priority filter" }, { status: 400 });
			}
			priority = normalizedPriority as "high" | "medium" | "low";
		}

		// Resolve parent task ID if provided
		let parentTaskId: string | undefined;
		if (parent) {
			const store = await this.getContentStoreInstance();
			const allTasks = store.getTasks();
			let parentTask = findTaskByLooseId(allTasks, parent);
			if (!parentTask) {
				const fallbackId = ensurePrefix(parent);
				const fallback = await this.core.filesystem.loadTask(fallbackId);
				if (fallback) {
					store.upsertTask(fallback);
					parentTask = fallback;
				}
			}
			if (!parentTask) {
				const normalizedParent = ensurePrefix(parent);
				return Response.json({ error: `Parent task ${normalizedParent} not found` }, { status: 404 });
			}
			parentTaskId = parentTask.id;
		}

		// Use Core.queryTasks which handles all filtering and cross-branch logic
		const tasks = await this.core.queryTasks({
			filters: { status, assignee, priority, parentTaskId, labels: labels.length > 0 ? labels : undefined },
			includeCrossBranch: crossBranch,
		});

		return Response.json(tasks);
	}

	private async handleSearch(req: Request): Promise<Response> {
		try {
			const searchService = await this.getSearchServiceInstance();
			const url = new URL(req.url);
			const query = url.searchParams.get("query") ?? undefined;
			const limitParam = url.searchParams.get("limit");
			const typeParams = [...url.searchParams.getAll("type"), ...url.searchParams.getAll("types")];
			const statusParams = url.searchParams.getAll("status");
			const priorityParamsRaw = url.searchParams.getAll("priority");
			const assigneeParamsRaw = [...url.searchParams.getAll("assignee"), ...url.searchParams.getAll("assignees")];
			const labelParamsRaw = [...url.searchParams.getAll("label"), ...url.searchParams.getAll("labels")];
			const modifiedFileParamsRaw = [
				...url.searchParams.getAll("modifiedFile"),
				...url.searchParams.getAll("modifiedFiles"),
			];
			const assigneesCsv = url.searchParams.get("assignees");
			if (assigneesCsv) {
				assigneeParamsRaw.push(...assigneesCsv.split(","));
			}
			const labelsCsv = url.searchParams.get("labels");
			if (labelsCsv) {
				labelParamsRaw.push(...labelsCsv.split(","));
			}
			const modifiedFilesCsv = url.searchParams.get("modifiedFiles");
			if (modifiedFilesCsv) {
				modifiedFileParamsRaw.push(...modifiedFilesCsv.split(","));
			}

			let limit: number | undefined;
			if (limitParam) {
				const parsed = Number.parseInt(limitParam, 10);
				if (Number.isNaN(parsed) || parsed <= 0) {
					return Response.json({ error: "limit must be a positive integer" }, { status: 400 });
				}
				limit = parsed;
			}

			let types: SearchResultType[] | undefined;
			if (typeParams.length > 0) {
				const allowed: SearchResultType[] = ["task", "document", "decision"];
				const normalizedTypes = typeParams
					.map((value) => value.toLowerCase())
					.filter((value): value is SearchResultType => {
						return allowed.includes(value as SearchResultType);
					});
				if (normalizedTypes.length === 0) {
					return Response.json({ error: "type must be task, document, or decision" }, { status: 400 });
				}
				types = normalizedTypes;
			}

			const filters: {
				status?: string | string[];
				priority?: SearchPriorityFilter | SearchPriorityFilter[];
				assignee?: string | string[];
				labels?: string | string[];
				modifiedFiles?: string | string[];
			} = {};

			if (statusParams.length === 1) {
				filters.status = statusParams[0];
			} else if (statusParams.length > 1) {
				filters.status = statusParams;
			}

			if (priorityParamsRaw.length > 0) {
				const allowedPriorities: SearchPriorityFilter[] = ["high", "medium", "low"];
				const normalizedPriorities = priorityParamsRaw.map((value) => value.toLowerCase());
				const invalidPriority = normalizedPriorities.find(
					(value) => !allowedPriorities.includes(value as SearchPriorityFilter),
				);
				if (invalidPriority) {
					return Response.json(
						{ error: `Unsupported priority '${invalidPriority}'. Use high, medium, or low.` },
						{ status: 400 },
					);
				}
				const casted = normalizedPriorities as SearchPriorityFilter[];
				filters.priority = casted.length === 1 ? casted[0] : casted;
			}

			if (assigneeParamsRaw.length > 0) {
				const normalizedAssignees = assigneeParamsRaw.map((value) => value.trim()).filter((value) => value.length > 0);
				if (normalizedAssignees.length > 0) {
					filters.assignee = normalizedAssignees.length === 1 ? normalizedAssignees[0] : normalizedAssignees;
				}
			}

			if (labelParamsRaw.length > 0) {
				const normalizedLabels = labelParamsRaw.map((value) => value.trim()).filter((value) => value.length > 0);
				if (normalizedLabels.length > 0) {
					filters.labels = normalizedLabels.length === 1 ? normalizedLabels[0] : normalizedLabels;
				}
			}

			if (modifiedFileParamsRaw.length > 0) {
				const normalizedModifiedFiles = modifiedFileParamsRaw
					.map((value) => value.trim())
					.filter((value) => value.length > 0);
				if (normalizedModifiedFiles.length > 0) {
					filters.modifiedFiles =
						normalizedModifiedFiles.length === 1 ? normalizedModifiedFiles[0] : normalizedModifiedFiles;
				}
			}

			const results = searchService.search({ query, limit, types, filters });
			return Response.json(results);
		} catch (error) {
			console.error("Error performing search:", error);
			return Response.json({ error: "Search failed" }, { status: 500 });
		}
	}

	private async handleCreateTask(req: Request): Promise<Response> {
		const payload = await req.json();

		if (!payload || typeof payload.title !== "string" || payload.title.trim().length === 0) {
			return Response.json({ error: "Title is required" }, { status: 400 });
		}

		const acceptanceCriteria = Array.isArray(payload.acceptanceCriteriaItems)
			? payload.acceptanceCriteriaItems
					.map((item: { text?: string; checked?: boolean }) => ({
						text: String(item?.text ?? "").trim(),
						checked: Boolean(item?.checked),
					}))
					.filter((item: { text: string }) => item.text.length > 0)
			: [];
		const definitionOfDoneAdd = Array.isArray(payload.definitionOfDoneAdd)
			? payload.definitionOfDoneAdd
					.map((item: unknown) => String(item ?? "").trim())
					.filter((item: string) => item.length > 0)
			: [];
		const disableDefinitionOfDoneDefaults = Boolean(payload.disableDefinitionOfDoneDefaults);

		try {
			const milestone =
				typeof payload.milestone === "string" ? await this.resolveMilestoneInput(payload.milestone) : undefined;

			const { task: createdTask } = await this.core.createTaskFromInput({
				title: payload.title,
				description: payload.description,
				status: payload.status,
				priority: payload.priority,
				milestone,
				labels: payload.labels,
				assignee: payload.assignee,
				dependencies: payload.dependencies,
				references: payload.references,
				modifiedFiles: payload.modifiedFiles,
				parentTaskId: payload.parentTaskId,
				implementationPlan: payload.implementationPlan,
				implementationNotes: payload.implementationNotes,
				finalSummary: payload.finalSummary,
				acceptanceCriteria,
				definitionOfDoneAdd,
				disableDefinitionOfDoneDefaults,
				onStatusChange: typeof payload.onStatusChange === "string" ? payload.onStatusChange : undefined,
				agent: typeof payload.agent === "string" ? payload.agent : undefined,
				reviewAgent: typeof payload.reviewAgent === "string" ? payload.reviewAgent : undefined,
			});
			return Response.json(createdTask, { status: 201 });
		} catch (error) {
			if (isCreateLockError(error)) {
				const message = error instanceof Error ? error.message : "Failed to create task";
				return Response.json({ error: message }, { status: 409 });
			}
			const message = error instanceof Error ? error.message : "Failed to create task";
			return Response.json({ error: message }, { status: 400 });
		}
	}

	private async handleGetTask(taskId: string): Promise<Response> {
		const store = await this.getContentStoreInstance();

		const localTask = await this.core.filesystem.loadTask(taskId);
		if (localTask) {
			store.upsertTask(localTask);
			return Response.json(localTask);
		}

		const task = findTaskByLooseId(store.getTasks(), taskId);
		if (task) {
			return Response.json(task);
		}

		return Response.json({ error: "Task not found" }, { status: 404 });
	}

	private async handleUpdateTask(req: Request, taskId: string): Promise<Response> {
		const updates = await req.json();
		const existingTask = await this.core.filesystem.loadTask(taskId);
		if (!existingTask) {
			return Response.json({ error: "Task not found" }, { status: 404 });
		}

		const updateInput: TaskUpdateInput = {};

		if ("title" in updates && typeof updates.title === "string") {
			updateInput.title = updates.title;
		}

		if ("description" in updates && typeof updates.description === "string") {
			updateInput.description = updates.description;
		}

		if ("status" in updates && typeof updates.status === "string") {
			updateInput.status = updates.status;
		}

		if ("priority" in updates && typeof updates.priority === "string") {
			updateInput.priority = updates.priority;
		}

		if ("milestone" in updates && (typeof updates.milestone === "string" || updates.milestone === null)) {
			if (typeof updates.milestone === "string") {
				updateInput.milestone = await this.resolveMilestoneInput(updates.milestone);
			} else {
				updateInput.milestone = updates.milestone;
			}
		}

		if ("labels" in updates && Array.isArray(updates.labels)) {
			updateInput.labels = updates.labels;
		}

		if ("assignee" in updates && Array.isArray(updates.assignee)) {
			updateInput.assignee = updates.assignee;
		}

		if ("dependencies" in updates && Array.isArray(updates.dependencies)) {
			updateInput.dependencies = updates.dependencies;
		}

		if ("references" in updates && Array.isArray(updates.references)) {
			updateInput.references = updates.references;
		}

		if ("modifiedFiles" in updates && Array.isArray(updates.modifiedFiles)) {
			updateInput.modifiedFiles = updates.modifiedFiles;
		}

		if ("implementationPlan" in updates && typeof updates.implementationPlan === "string") {
			updateInput.implementationPlan = updates.implementationPlan;
		}

		if ("implementationNotes" in updates && typeof updates.implementationNotes === "string") {
			updateInput.implementationNotes = updates.implementationNotes;
		}

		if ("finalSummary" in updates && typeof updates.finalSummary === "string") {
			updateInput.finalSummary = updates.finalSummary;
		}

		if (
			"onStatusChange" in updates &&
			(typeof updates.onStatusChange === "string" || updates.onStatusChange === null)
		) {
			updateInput.onStatusChange = updates.onStatusChange;
		}

		for (const field of ["agent", "reviewAgent"] as const) {
			if (field in updates && (typeof updates[field] === "string" || updates[field] === null)) {
				updateInput[field] = updates[field] as string | null;
			}
		}

		if ("acceptanceCriteriaItems" in updates && Array.isArray(updates.acceptanceCriteriaItems)) {
			updateInput.acceptanceCriteria = updates.acceptanceCriteriaItems
				.map((item: { text?: string; checked?: boolean }) => ({
					text: String(item?.text ?? "").trim(),
					checked: Boolean(item?.checked),
				}))
				.filter((item: { text: string }) => item.text.length > 0);
		}

		if ("definitionOfDoneAdd" in updates && Array.isArray(updates.definitionOfDoneAdd)) {
			updateInput.addDefinitionOfDone = updates.definitionOfDoneAdd
				.map((item: unknown) => ({ text: String(item ?? "").trim(), checked: false }))
				.filter((item: { text: string }) => item.text.length > 0);
		}

		if ("definitionOfDoneRemove" in updates && Array.isArray(updates.definitionOfDoneRemove)) {
			updateInput.removeDefinitionOfDone = updates.definitionOfDoneRemove.filter(
				(value: unknown) => typeof value === "number" && Number.isFinite(value),
			);
		}

		if ("definitionOfDoneCheck" in updates && Array.isArray(updates.definitionOfDoneCheck)) {
			updateInput.checkDefinitionOfDone = updates.definitionOfDoneCheck.filter(
				(value: unknown) => typeof value === "number" && Number.isFinite(value),
			);
		}

		if ("definitionOfDoneUncheck" in updates && Array.isArray(updates.definitionOfDoneUncheck)) {
			updateInput.uncheckDefinitionOfDone = updates.definitionOfDoneUncheck.filter(
				(value: unknown) => typeof value === "number" && Number.isFinite(value),
			);
		}

		try {
			const updatedTask = await this.core.updateTaskFromInput(taskId, updateInput);
			return Response.json(updatedTask);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Failed to update task";
			return Response.json({ error: message }, { status: 400 });
		}
	}

	private async handleDeleteTask(taskId: string): Promise<Response> {
		const success = await this.core.archiveTask(taskId);
		if (!success) {
			return Response.json({ error: "Task not found" }, { status: 404 });
		}
		return Response.json({ success: true });
	}

	private async handleCompleteTask(taskId: string): Promise<Response> {
		try {
			const task = await this.core.filesystem.loadTask(taskId);
			if (!task) {
				return Response.json({ error: "Task not found" }, { status: 404 });
			}

			const success = await this.core.completeTask(taskId);
			if (!success) {
				return Response.json({ error: "Failed to complete task" }, { status: 500 });
			}

			// Notify listeners to refresh
			this.broadcastTasksUpdated();
			return Response.json({ success: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Failed to complete task";
			console.error("Error completing task:", error);
			return Response.json({ error: message }, { status: 500 });
		}
	}

	private async handleGetStatuses(): Promise<Response> {
		const config = await this.core.filesystem.loadConfig();
		const statuses = config?.statuses || ["To Do", "In Progress", "Done"];
		return Response.json(statuses);
	}

	// Documentation handlers
	private async handleListDocs(): Promise<Response> {
		try {
			const store = await this.getContentStoreInstance();
			const docs = store.getDocuments();
			const docFiles = docs.map((doc) => ({
				name: doc.path?.split(/[\\/]+/).pop() ?? `${doc.title}.md`,
				id: doc.id,
				title: doc.title,
				type: doc.type,
				path: doc.path,
				createdDate: doc.createdDate,
				updatedDate: doc.updatedDate,
				lastModified: doc.updatedDate || doc.createdDate,
				tags: doc.tags || [],
			}));
			return Response.json(docFiles);
		} catch (error) {
			console.error("Error listing documents:", error);
			return Response.json([]);
		}
	}

	private async handleGetDoc(docId: string): Promise<Response> {
		try {
			const doc = await this.core.getDocument(docId);
			if (!doc) {
				return Response.json({ error: "Document not found" }, { status: 404 });
			}
			return Response.json(doc);
		} catch (error) {
			console.error("Error loading document:", error);
			return Response.json({ error: "Document not found" }, { status: 404 });
		}
	}

	private async handleCreateDoc(req: Request): Promise<Response> {
		try {
			const body = await req.json();
			const filename = typeof body?.filename === "string" ? body.filename : undefined;
			const title = typeof body?.title === "string" ? body.title : filename?.replace(/\.md$/i, "");
			if (!title || title.trim().length === 0) {
				return Response.json({ error: "Document title is required" }, { status: 400 });
			}
			const type = parseDocumentType(body?.type);
			const path = parseCreateDocumentPath(body?.path);
			const tags = parseDocumentTags(body?.tags);

			const document = await this.core.createDocumentFromInput({
				title,
				content: typeof body?.content === "string" ? body.content : "",
				type,
				path,
				tags,
			});
			return Response.json({ success: true, ...document }, { status: 201 });
		} catch (error) {
			if (error instanceof SyntaxError) {
				return Response.json({ error: "Invalid request payload" }, { status: 400 });
			}
			if (error instanceof Error && isDocumentValidationError(error)) {
				return Response.json({ error: error.message }, { status: 400 });
			}
			console.error("Error creating document:", error);
			return Response.json({ error: "Failed to create document" }, { status: 500 });
		}
	}

	private async handleUpdateDoc(req: Request, docId: string): Promise<Response> {
		try {
			const body = await req.json();
			const content = typeof body?.content === "string" ? body.content : undefined;
			const title = typeof body?.title === "string" ? body.title : undefined;
			const path = parseUpdateDocumentPath(body?.path);
			const type = parseDocumentType(body?.type);
			const tags = parseDocumentTags(body?.tags);

			if (typeof content !== "string") {
				return Response.json({ error: "Document content is required" }, { status: 400 });
			}

			let normalizedTitle: string | undefined;

			if (typeof title === "string") {
				normalizedTitle = title.trim();
				if (normalizedTitle.length === 0) {
					return Response.json({ error: "Document title cannot be empty" }, { status: 400 });
				}
			}

			const document = await this.core.updateDocumentFromInput({
				id: docId,
				content,
				...(normalizedTitle && { title: normalizedTitle }),
				...(path !== undefined && { path }),
				...(type !== undefined && { type }),
				...(tags !== undefined && { tags }),
			});
			return Response.json({ success: true, ...document });
		} catch (error) {
			if (error instanceof SyntaxError) {
				return Response.json({ error: "Invalid request payload" }, { status: 400 });
			}
			if (error instanceof Error) {
				if (error.message.startsWith("Document not found")) {
					return Response.json({ error: error.message }, { status: 404 });
				}
				if (isDocumentValidationError(error)) {
					return Response.json({ error: error.message }, { status: 400 });
				}
			}
			console.error("Error updating document:", error);
			return Response.json({ error: "Failed to update document" }, { status: 500 });
		}
	}

	// Decision handlers
	private async handleListDecisions(): Promise<Response> {
		try {
			const store = await this.getContentStoreInstance();
			const decisions = store.getDecisions();
			const decisionFiles = decisions.map((decision) => ({
				id: decision.id,
				title: decision.title,
				status: decision.status,
				date: decision.date,
				context: decision.context,
				decision: decision.decision,
				consequences: decision.consequences,
				alternatives: decision.alternatives,
			}));
			return Response.json(decisionFiles);
		} catch (error) {
			console.error("Error listing decisions:", error);
			return Response.json([]);
		}
	}

	private async handleGetDecision(decisionId: string): Promise<Response> {
		try {
			const store = await this.getContentStoreInstance();
			const normalizedId = decisionId.startsWith("decision-") ? decisionId : `decision-${decisionId}`;
			const decision = store.getDecisions().find((item) => item.id === normalizedId || item.id === decisionId);

			if (!decision) {
				return Response.json({ error: "Decision not found" }, { status: 404 });
			}

			return Response.json(decision);
		} catch (error) {
			console.error("Error loading decision:", error);
			return Response.json({ error: "Decision not found" }, { status: 404 });
		}
	}

	private async handleCreateDecision(req: Request): Promise<Response> {
		const { title } = await req.json();

		try {
			const decision = await this.core.createDecisionWithTitle(title);
			return Response.json(decision, { status: 201 });
		} catch (error) {
			console.error("Error creating decision:", error);
			return Response.json({ error: "Failed to create decision" }, { status: 500 });
		}
	}

	private async handleUpdateDecision(req: Request, decisionId: string): Promise<Response> {
		const content = await req.text();

		try {
			await this.core.updateDecisionFromContent(decisionId, content);
			return Response.json({ success: true });
		} catch (error) {
			if (error instanceof Error && error.message.includes("not found")) {
				return Response.json({ error: "Decision not found" }, { status: 404 });
			}
			console.error("Error updating decision:", error);
			return Response.json({ error: "Failed to update decision" }, { status: 500 });
		}
	}

	private async handleGetConfig(): Promise<Response> {
		try {
			const config = await this.core.filesystem.loadConfig();
			if (!config) {
				return Response.json({ error: "Configuration not found" }, { status: 404 });
			}
			return Response.json(config);
		} catch (error) {
			console.error("Error loading config:", error);
			return Response.json({ error: "Failed to load configuration" }, { status: 500 });
		}
	}

	private async handleUpdateConfig(req: Request): Promise<Response> {
		try {
			const updatedConfig = await req.json();

			// Validate configuration
			if (!updatedConfig.projectName?.trim()) {
				return Response.json({ error: "Project name is required" }, { status: 400 });
			}

			if (updatedConfig.defaultPort && (updatedConfig.defaultPort < 1 || updatedConfig.defaultPort > 65535)) {
				return Response.json({ error: "Port must be between 1 and 65535" }, { status: 400 });
			}

			// Save configuration
			await this.core.filesystem.saveConfig(updatedConfig);

			// Update local project name if changed
			if (updatedConfig.projectName !== this.projectName) {
				this.projectName = updatedConfig.projectName;
			}

			// Notify connected clients so that they refresh configuration-dependent data (e.g., statuses)
			this.broadcastTasksUpdated();

			return Response.json(updatedConfig);
		} catch (error) {
			console.error("Error updating config:", error);
			return Response.json({ error: "Failed to update configuration" }, { status: 500 });
		}
	}

	private handleError(error: Error): Response {
		console.error("Server Error:", error);
		return new Response("Internal Server Error", { status: 500 });
	}

	// Draft handlers
	private async handleListDrafts(): Promise<Response> {
		try {
			const drafts = await this.core.filesystem.listDrafts();
			return Response.json(drafts);
		} catch (error) {
			console.error("Error listing drafts:", error);
			return Response.json([]);
		}
	}

	private async handlePromoteDraft(draftId: string): Promise<Response> {
		try {
			const success = await this.core.promoteDraft(draftId);
			if (!success) {
				return Response.json({ error: "Draft not found" }, { status: 404 });
			}
			return Response.json({ success: true });
		} catch (error) {
			console.error("Error promoting draft:", error);
			if (isCreateLockError(error)) {
				return Response.json({ error: error.message }, { status: 409 });
			}
			return Response.json({ error: "Failed to promote draft" }, { status: 500 });
		}
	}

	// Milestone handlers
	private async readOptionalJsonBody(req: Request): Promise<Record<string, unknown>> {
		const text = await req.text();
		if (!text.trim()) {
			return {};
		}

		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			throw new BacklogToolError("Request body must be valid JSON.", "VALIDATION_ERROR");
		}

		if (!body || typeof body !== "object" || Array.isArray(body)) {
			throw new BacklogToolError("Request body must be a JSON object.", "VALIDATION_ERROR");
		}

		return body as Record<string, unknown>;
	}

	private getMilestoneMutationMessage(result: { content: Array<{ type: string; text?: string }> }): string {
		return result.content
			.filter((item) => item.type === "text" && typeof item.text === "string")
			.map((item) => item.text)
			.join("\n");
	}

	private milestoneMutationErrorResponse(error: unknown, context: string): Response {
		const status =
			error instanceof BacklogToolError
				? error.code === "NOT_FOUND"
					? 404
					: error.code === "VALIDATION_ERROR"
						? 400
						: 500
				: 500;
		const message = error instanceof Error ? error.message : context;
		if (status === 500) {
			console.error(context, error);
		}
		return Response.json(
			{ error: message, code: error instanceof BacklogToolError ? error.code : "INTERNAL_ERROR" },
			{ status },
		);
	}

	private async handleListMilestones(): Promise<Response> {
		try {
			const milestones = await this.core.filesystem.listMilestones();
			return Response.json(milestones);
		} catch (error) {
			console.error("Error listing milestones:", error);
			return Response.json([]);
		}
	}

	private async handleListArchivedMilestones(): Promise<Response> {
		try {
			const milestones = await this.core.filesystem.listArchivedMilestones();
			return Response.json(milestones);
		} catch (error) {
			console.error("Error listing archived milestones:", error);
			return Response.json([]);
		}
	}

	private async handleGetMilestone(milestoneId: string): Promise<Response> {
		try {
			const milestone = await this.core.filesystem.loadMilestone(milestoneId);
			if (!milestone) {
				return Response.json({ error: "Milestone not found" }, { status: 404 });
			}
			return Response.json(milestone);
		} catch (error) {
			console.error("Error loading milestone:", error);
			return Response.json({ error: "Milestone not found" }, { status: 404 });
		}
	}

	private async handleCreateMilestone(req: Request): Promise<Response> {
		try {
			const body = (await req.json()) as { title?: string; description?: string };
			const title = body.title?.trim();

			if (!title) {
				return Response.json({ error: "Milestone title is required" }, { status: 400 });
			}

			// Check for duplicates
			const existingMilestones = await this.core.filesystem.listMilestones();
			const buildAliasKeys = (value: string): Set<string> => {
				const normalized = value.trim().toLowerCase();
				const keys = new Set<string>();
				if (!normalized) {
					return keys;
				}
				keys.add(normalized);
				if (/^\d+$/.test(normalized)) {
					const numeric = String(Number.parseInt(normalized, 10));
					keys.add(numeric);
					keys.add(`m-${numeric}`);
					return keys;
				}
				const match = normalized.match(/^m-(\d+)$/);
				if (match?.[1]) {
					const numeric = String(Number.parseInt(match[1], 10));
					keys.add(numeric);
					keys.add(`m-${numeric}`);
				}
				return keys;
			};
			const requestedKeys = buildAliasKeys(title);
			const duplicate = existingMilestones.find((milestone) => {
				const milestoneKeys = new Set<string>([...buildAliasKeys(milestone.id), ...buildAliasKeys(milestone.title)]);
				for (const key of requestedKeys) {
					if (milestoneKeys.has(key)) {
						return true;
					}
				}
				return false;
			});
			if (duplicate) {
				return Response.json({ error: "A milestone with this title or ID already exists" }, { status: 400 });
			}

			const milestone = await this.core.filesystem.createMilestone(title, body.description);
			return Response.json(milestone, { status: 201 });
		} catch (error) {
			console.error("Error creating milestone:", error);
			return Response.json({ error: "Failed to create milestone" }, { status: 500 });
		}
	}

	private async handleUpdateMilestone(req: Request, milestoneId: string): Promise<Response> {
		try {
			const body = await this.readOptionalJsonBody(req);
			const title = typeof body.title === "string" ? body.title.trim() : "";
			const updateTasks = typeof body.updateTasks === "boolean" ? body.updateTasks : true;

			if (!title) {
				return Response.json({ error: "Milestone title is required" }, { status: 400 });
			}

			const sourceMilestone = await this.core.filesystem.loadMilestone(milestoneId);
			const result = await new MilestoneHandlers(this.core).renameMilestone({
				from: milestoneId,
				to: title,
				updateTasks,
			});
			const milestone =
				(await this.core.filesystem.loadMilestone(sourceMilestone?.id ?? milestoneId)) ??
				(await this.core.filesystem.loadMilestone(title));
			this.broadcastTasksUpdated();
			return Response.json({
				success: true,
				milestone: milestone ?? null,
				message: this.getMilestoneMutationMessage(result),
			});
		} catch (error) {
			return this.milestoneMutationErrorResponse(error, "Error updating milestone");
		}
	}

	private async handleRemoveMilestone(req: Request, milestoneId: string): Promise<Response> {
		try {
			const body = await this.readOptionalJsonBody(req);
			const rawTaskHandling = body.taskHandling;
			const taskHandling =
				rawTaskHandling === undefined
					? "clear"
					: rawTaskHandling === "clear" || rawTaskHandling === "keep" || rawTaskHandling === "reassign"
						? rawTaskHandling
						: null;
			const reassignTo = typeof body.reassignTo === "string" ? body.reassignTo : undefined;

			if (!taskHandling) {
				return Response.json({ error: "taskHandling must be clear, keep, or reassign" }, { status: 400 });
			}

			const result = await new MilestoneHandlers(this.core).removeMilestone({
				name: milestoneId,
				taskHandling,
				reassignTo,
			});
			this.broadcastTasksUpdated();
			return Response.json({
				success: true,
				message: this.getMilestoneMutationMessage(result),
			});
		} catch (error) {
			return this.milestoneMutationErrorResponse(error, "Error removing milestone");
		}
	}

	private async handleArchiveMilestone(milestoneId: string): Promise<Response> {
		try {
			const result = await this.core.archiveMilestone(milestoneId);
			if (!result.success) {
				return Response.json({ error: "Milestone not found" }, { status: 404 });
			}
			this.broadcastTasksUpdated();
			return Response.json({ success: true, milestone: result.milestone ?? null });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Failed to archive milestone";
			console.error("Error archiving milestone:", error);
			return Response.json({ error: message }, { status: 500 });
		}
	}

	private async handleGetVersion(): Promise<Response> {
		try {
			const version = await getVersion();
			return Response.json({ version });
		} catch (error) {
			console.error("Error getting version:", error);
			return Response.json({ error: "Failed to get version" }, { status: 500 });
		}
	}

	private async handleReorderTask(req: Request): Promise<Response> {
		try {
			const body = await req.json();
			const taskId = typeof body.taskId === "string" ? body.taskId : "";
			const targetStatus = typeof body.targetStatus === "string" ? body.targetStatus : "";
			const orderedTaskIds = Array.isArray(body.orderedTaskIds) ? body.orderedTaskIds : [];
			const targetMilestone =
				typeof body.targetMilestone === "string"
					? body.targetMilestone
					: body.targetMilestone === null
						? null
						: undefined;

			if (!taskId || !targetStatus || orderedTaskIds.length === 0) {
				return Response.json(
					{ error: "Missing required fields: taskId, targetStatus, and orderedTaskIds" },
					{ status: 400 },
				);
			}

			const { updatedTask } = await this.core.reorderTask({
				taskId,
				targetStatus,
				orderedTaskIds,
				targetMilestone,
				commitMessage: `Reorder tasks in ${targetStatus}`,
			});

			return Response.json({ success: true, task: updatedTask });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Failed to reorder task";
			// Cross-branch and validation errors are client errors (400), not server errors (500)
			const isCrossBranchError = message.includes("exists in branch");
			const isValidationError = message.includes("not found") || message.includes("Missing required");
			const status = isCrossBranchError || isValidationError ? 400 : 500;
			if (status === 500) {
				console.error("Error reordering task:", error);
			}
			return Response.json({ error: message }, { status });
		}
	}

	private async handleCleanupPreview(req: Request): Promise<Response> {
		try {
			const url = new URL(req.url);
			const ageParam = url.searchParams.get("age");

			if (!ageParam) {
				return Response.json({ error: "Missing age parameter" }, { status: 400 });
			}

			const age = Number.parseInt(ageParam, 10);
			if (Number.isNaN(age) || age < 0) {
				return Response.json({ error: "Invalid age parameter" }, { status: 400 });
			}

			const tasksToCleanup = await this.core.getTerminalStatusTasksByAge(age);

			// Return preview of tasks to be cleaned up
			const preview = tasksToCleanup.map((task) => ({
				id: task.id,
				title: task.title,
				updatedDate: task.updatedDate,
				createdDate: task.createdDate,
			}));

			return Response.json({
				count: preview.length,
				tasks: preview,
			});
		} catch (error) {
			console.error("Error getting cleanup preview:", error);
			return Response.json({ error: "Failed to get cleanup preview" }, { status: 500 });
		}
	}

	private async handleCleanupExecute(req: Request): Promise<Response> {
		try {
			const { age } = await req.json();

			if (age === undefined || age === null) {
				return Response.json({ error: "Missing age parameter" }, { status: 400 });
			}

			const ageInDays = Number.parseInt(age, 10);
			if (Number.isNaN(ageInDays) || ageInDays < 0) {
				return Response.json({ error: "Invalid age parameter" }, { status: 400 });
			}

			const tasksToCleanup = await this.core.getTerminalStatusTasksByAge(ageInDays);

			if (tasksToCleanup.length === 0) {
				return Response.json({
					success: true,
					movedCount: 0,
					message: "No tasks to clean up",
				});
			}

			// Move tasks to completed folder
			let successCount = 0;
			const failedTasks: string[] = [];

			for (const task of tasksToCleanup) {
				try {
					const success = await this.core.completeTask(task.id);
					if (success) {
						successCount++;
					} else {
						failedTasks.push(task.id);
					}
				} catch (error) {
					console.error(`Failed to complete task ${task.id}:`, error);
					failedTasks.push(task.id);
				}
			}

			// Notify listeners to refresh
			this.broadcastTasksUpdated();

			return Response.json({
				success: true,
				movedCount: successCount,
				totalCount: tasksToCleanup.length,
				failedTasks: failedTasks.length > 0 ? failedTasks : undefined,
				message: `Moved ${successCount} of ${tasksToCleanup.length} tasks to completed folder`,
			});
		} catch (error) {
			console.error("Error executing cleanup:", error);
			return Response.json({ error: "Failed to execute cleanup" }, { status: 500 });
		}
	}

	// Sequences handlers
	private async handleGetSequences(): Promise<Response> {
		const data = await this.core.listActiveSequences();
		return Response.json(data);
	}

	private async handleMoveSequence(req: Request): Promise<Response> {
		try {
			const body = await req.json();
			const taskId = String(body.taskId || "").trim();
			const moveToUnsequenced = Boolean(body.unsequenced === true);
			const targetSequenceIndex = body.targetSequenceIndex !== undefined ? Number(body.targetSequenceIndex) : undefined;

			if (!taskId) return Response.json({ error: "taskId is required" }, { status: 400 });

			const next = await this.core.moveTaskInSequences({
				taskId,
				unsequenced: moveToUnsequenced,
				targetSequenceIndex,
			});
			return Response.json(next);
		} catch (error) {
			const message = (error as Error)?.message || "Invalid request";
			return Response.json({ error: message }, { status: 400 });
		}
	}

	private async handleGetStatistics(): Promise<Response> {
		try {
			// Load tasks using the same logic as CLI overview
			const { tasks, drafts, statuses } = await this.core.loadAllTasksForStatistics();

			// Calculate statistics using the exact same function as CLI
			const statistics = getTaskStatistics(tasks, drafts, statuses);

			// Convert Maps to objects for JSON serialization
			const response = {
				...statistics,
				statusCounts: Object.fromEntries(statistics.statusCounts),
				priorityCounts: Object.fromEntries(statistics.priorityCounts),
			};

			return Response.json(response);
		} catch (error) {
			console.error("Error getting statistics:", error);
			return Response.json({ error: "Failed to get statistics" }, { status: 500 });
		}
	}

	private async handleGetStatus(): Promise<Response> {
		try {
			const config = await this.core.filesystem.loadConfig();
			const backlogResolution = this.core.filesystem.resolveBacklogDirectoryInfo();
			const shellInvocation = resolveShellInvocation(config?.shell);
			const shellAvailability = probeShellAvailability();
			return Response.json({
				initialized: !!config,
				projectPath: this.core.filesystem.rootDir,
				backlogDirectory: backlogResolution.backlogDir,
				backlogDirectorySource: backlogResolution.source,
				configLocation: backlogResolution.configSource,
				rootConfigPath: backlogResolution.rootConfigPath,
				statusCallbackCapabilities: {
					platform: process.platform,
					resolvedShell: shellInvocation.cmd,
					willFallbackToCmd: Boolean(shellInvocation.warning),
					shellAvailability,
				},
			});
		} catch (error) {
			console.error("Error getting status:", error);
			return Response.json({
				initialized: false,
				projectPath: this.core.filesystem.rootDir,
				backlogDirectory: null,
				backlogDirectorySource: null,
				configLocation: null,
				rootConfigPath: null,
			});
		}
	}

	/**
	 * Newest dispatch per (taskId, status), from the `.pid` files dispatch.ps1
	 * writes after Start-Process. Stems are timestamp-prefixed, so lexicographic
	 * order is chronological.
	 */
	private latestDispatches(files: readonly string[]): Map<string, { stem: string; taskId: string; status: string }> {
		const latest = new Map<string, { stem: string; taskId: string; status: string }>();
		for (const file of files) {
			const parsed = parseLogStem(file, ".log.pid");
			if (!parsed) continue;
			const key = `${parsed.taskId}::${parsed.status}`;
			const previous = latest.get(key);
			if (!previous || previous.stem.localeCompare(parsed.stem) < 0) latest.set(key, parsed);
		}
		return latest;
	}

	/**
	 * Whether one dispatch is really still working.
	 *
	 * Shared by /api/agent-status and /api/agent-activity on purpose: a liveness
	 * rule enforced in one of them is enforced in neither, and the two disagreeing
	 * would mean a card spinning while its pane says idle. See `isLikelyRunning`
	 * for why a live pid alone is not evidence of anything.
	 */
	private async resolveLiveness(
		logsDir: string,
		stem: string,
		/**
		 * Authoritative current status of the dispatch's task, read on demand.
		 * Called ONLY when the pid resolves, because that is the only case where
		 * the status changes the answer — which keeps the cost at a couple of file
		 * reads per poll instead of one per historical dispatch.
		 */
		resolveTaskStatus: () => Promise<string | null>,
	): Promise<{
		pidAlive: boolean;
		statusMatches: boolean;
		silentMs: number | null;
		running: boolean;
		lastWriteMs: number | null;
	}> {
		let pid = 0;
		try {
			pid = Number.parseInt((await Bun.file(join(logsDir, `${stem}.log.pid`)).text()).trim(), 10);
		} catch {
			// .pid unreadable — pid stays 0, i.e. not alive
		}

		let pidAlive = false;
		if (pid > 0) {
			try {
				process.kill(pid, 0);
				pidAlive = true;
			} catch (e: unknown) {
				// EPERM = alive but not ours to signal; ESRCH = really gone.
				pidAlive = (e as NodeJS.ErrnoException).code === "EPERM";
			}
		}

		let silentMs: number | null = null;
		let lastWriteMs: number | null = null;
		try {
			const stat = await Bun.file(join(logsDir, `${stem}.log`)).stat();
			lastWriteMs = stat.mtimeMs;
			silentMs = Math.max(0, Date.now() - stat.mtimeMs);
		} catch {
			// log gone — leave null rather than inventing a time
		}

		// No live pid means nothing is working, whatever the task status says.
		if (!pidAlive) {
			return { pidAlive: false, statusMatches: false, silentMs, lastWriteMs, running: false };
		}

		const dispatchStatus = await resolveTaskStatus();
		const statusMatches = dispatchStatus !== null;
		return {
			pidAlive,
			statusMatches,
			silentMs,
			lastWriteMs,
			running: isLikelyRunning({ pidAlive, statusMatches, silentMs }),
		};
	}

	/**
	 * Read one task's status straight from disk.
	 *
	 * Deliberately not the cached content store: when another process holds the
	 * watcher lock this server installs no watcher, so its cache can sit stale
	 * indefinitely with only a startup warning. A liveness rule built on a stale
	 * status reports agents working on tasks that finished hours ago — the exact
	 * lie this whole change exists to remove.
	 */
	private async freshTaskStatus(taskId: string, cachedId?: string): Promise<string | null> {
		for (const candidate of [cachedId, taskId]) {
			if (!candidate) continue;
			try {
				const task = await this.core.filesystem.loadTask(candidate);
				if (task) return task.status;
			} catch {
				// unreadable / not found — try the next spelling
			}
		}
		return null;
	}

	private async handleGetAgentStatus(): Promise<Response> {
		const logsDir = join(this.core.filesystem.backlogDir, "prompts", "logs");
		let files: string[];
		try {
			files = await readdir(logsDir);
		} catch {
			return Response.json([]);
		}

		// The cached store only supplies the task's canonical id spelling; the
		// status itself is read fresh (see freshTaskStatus) and only when needed.
		const store = await this.getContentStoreInstance().catch(() => null);
		const idById = new Map((store?.getTasks() ?? []).map((task) => [task.id.toLowerCase(), task.id]));

		const result = await Promise.all(
			Array.from(this.latestDispatches(files).values()).map(async ({ stem, taskId, status }) => {
				const { pidAlive, statusMatches, silentMs, running } = await this.resolveLiveness(
					logsDir,
					stem,
					async () => {
						const current = await this.freshTaskStatus(taskId, idById.get(taskId.toLowerCase()));
						return current === status ? current : null;
					},
				);
				const badge = deriveBadgeState({ running, pidAlive, statusMatches });
				return {
					taskId,
					status,
					running: badge === "running",
					// A live pid with a long-silent feed is neither running nor cleanly
					// finished — it is the stranded-session signature, and flattening it
					// into either one hides the thing worth seeing.
					stranded: badge === "stranded",
					completed: badge === "completed",
					pidAlive,
					silentMs,
				};
			}),
		);

		return Response.json(result);
	}

	private async handleGetAgentLog(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const taskId = url.searchParams.get("taskId");
		const status = url.searchParams.get("status");
		if (!taskId || !status) return new Response("Missing taskId or status", { status: 400 });

		const logsDir = join(this.core.filesystem.backlogDir, "prompts", "logs");
		let files: string[];
		try {
			files = await readdir(logsDir);
		} catch {
			return Response.json({ content: "No log directory found.", done: true });
		}

		// Match files for this (taskId, status): filename contains both segments.
		// safeTaskId/safeStatus use the same replacement as dispatch.ps1.
		const safeTaskId = taskId.replace(/[<>:"/\\|?*\s]+/g, "_");
		const safeStatus = status.replace(/[<>:"/\\|?*\s]+/g, "_");
		const matching = files
			.filter((f) => f.endsWith(".log") && f.includes(`-${safeTaskId}-`) && f.endsWith(`-${safeStatus}.log`))
			.sort()
			.at(-1); // most recent = last lexicographically (timestamp prefix)

		if (!matching) return Response.json({ content: "No log found yet.", done: true, logFile: "" });

		const logPath = join(logsDir, matching);
		const errPath = `${logPath}.err`;
		const pidPath = `${logPath}.pid`;

		// Prefer .log.err (human-readable for Codex) if it has substantial content.
		let raw = "";
		let usedErr = false;
		try {
			const err = await Bun.file(errPath).text();
			if (err.trim().length > 100) { raw = err; usedErr = true; }
		} catch { /* no .err file */ }

		if (!usedErr) {
			try { raw = await Bun.file(logPath).text(); } catch { /* unreadable */ }
		}

		// Check if agent process is still alive.
		let done = true;
		try {
			const pidStr = await Bun.file(pidPath).text();
			const pid = parseInt(pidStr.trim(), 10);
			if (pid > 0) {
				try { process.kill(pid, 0); done = false; }
				catch (e: unknown) { done = (e as NodeJS.ErrnoException).code !== "EPERM"; }
			}
		} catch { /* no .pid → done */ }

		return Response.json({ content: agentLogParse(raw, usedErr), done, logFile: matching });
	}

	/**
	 * Structured live activity for every agent the dispatcher currently has out.
	 *
	 * This is the board-level companion to /api/agent-log: instead of one task's
	 * raw text, it returns a normalized event stream, token totals, elapsed time
	 * and loop-guard hop count for all active dispatches at once, so the UI can
	 * show what each agent is doing without a request per card.
	 *
	 * The feed it reads depends on the agent, because they do not report equally:
	 *   - claude is launched with plain `-p`, whose stdout is only the closing
	 *     prose. The real record is Claude Code's own session transcript, so when
	 *     the task recorded a session id we read that instead of the dispatch log.
	 *   - codex is launched with `exec --json`, so its dispatch log is already a
	 *     structured stream.
	 *   - anything else falls back to the dispatch log as plain text.
	 */
	private async handleGetAgentActivity(): Promise<Response> {
		const logsDir = join(this.core.filesystem.backlogDir, "prompts", "logs");
		let files: string[];
		try {
			files = await readdir(logsDir);
		} catch {
			return Response.json([]);
		}

		const [config, store] = await Promise.all([
			this.core.filesystem.loadConfig().catch(() => null),
			this.getContentStoreInstance().catch(() => null),
		]);
		const tasks = store?.getTasks() ?? [];
		const taskById = new Map(tasks.map((task) => [task.id.toLowerCase(), task]));

		// Alias ("Claudio") -> binary ("claude"). A task may also name a binary
		// directly, which is why the lookup falls back to the value itself.
		const aliasToBinary = new Map((config?.agents ?? []).map((agent) => [agent.alias, agent.binary]));

		const entries = await Promise.all(
			Array.from(this.latestDispatches(files).values()).map(async ({ stem, taskId, status }) => {
				const logPath = join(logsDir, `${stem}.log`);
				const task = taskById.get(taskId.toLowerCase());

				// Status is read fresh from disk, not taken from the cached store,
				// which can sit stale when this server installed no watcher.
				const currentStatus = await this.freshTaskStatus(taskId, task?.id);
				// Drop historical dispatches — a task that has moved on is not being
				// worked by this one, no matter what its recycled pid resolves to.
				if (currentStatus !== status) return null;

				const phase = status === "In Progress" ? "coder" : status === "In Review" ? "reviewer" : "notifier";
				const agentName = (phase === "reviewer" ? task?.reviewAgent || task?.agent : task?.agent) ?? "";
				const agentBinary = aliasToBinary.get(agentName) ?? agentName;
				const kind = feedKindForBinary(agentBinary);

				// Prefer Claude's own transcript — the dispatch log for `claude -p`
				// carries no tool calls at all.
				const sessionIds = extractSessionIds(task?.rawContent ?? "");
				const sessionId = (phase === "reviewer" ? sessionIds.reviewer : sessionIds.coder) ?? null;
				let feedPath = logPath;
				let source: "claude-transcript" | "codex-json" | "log-text" = kind === "codex" ? "codex-json" : "log-text";
				// Without a transcript, a claude dispatch log is prose — read it as text.
				let feedKind: FeedKind = kind === "claude" ? "text" : kind;
				if (kind === "claude" && sessionId) {
					const transcript = join(
						homedir(),
						".claude",
						"projects",
						claudeProjectSlug(this.core.filesystem.rootDir),
						`${sessionId}.jsonl`,
					);
					if (await Bun.file(transcript).exists()) {
						feedPath = transcript;
						source = "claude-transcript";
						feedKind = "claude";
					}
				}

				const feed = await this.readAgentFeed(feedPath, feedKind);
				// Status was already confirmed fresh above, so the resolver is a
				// constant here rather than a second read of the same file.
				const liveness = await this.resolveLiveness(logsDir, stem, async () => status);
				const pidAlive = liveness.pidAlive;

				let startedAt: string | null = null;
				let lastActivityAt: string | null = feed.lastEventAt ?? null;
				try {
					const stat = await Bun.file(logPath).stat();
					startedAt = new Date(stat.birthtimeMs || stat.mtimeMs).toISOString();
					// Codex events carry no timestamps, so fall back to the file's mtime.
					if (!lastActivityAt) lastActivityAt = new Date(stat.mtimeMs).toISOString();
				} catch {
					// log file gone — leave these null rather than inventing a time
				}

				// Measure silence from the newest of the two sources: a claude
				// transcript can be moving while the (prose-only) dispatch log it was
				// dispatched with sits untouched for the whole session.
				const newestMs = Math.max(liveness.lastWriteMs ?? 0, lastActivityAt ? Date.parse(lastActivityAt) : 0);
				const silentMs = newestMs > 0 ? Math.max(0, Date.now() - newestMs) : null;
				// statusMatches is true by construction: a mismatch returned null above.
				const running = isLikelyRunning({ pidAlive, statusMatches: true, silentMs });

				const maxHops = 6; // dispatch.ps1 $maxRoundTrips
				return {
					taskId,
					taskTitle: task?.title ?? "",
					status,
					phase,
					agentName,
					agentBinary,
					running,
					// Surfaced separately on purpose: "pid alive but silent for hours" is
					// the stranded-session signature, and must not be flattened away.
					pidAlive,
					silentMs,
					startedAt,
					lastActivityAt,
					hop: hopCount(files, safeSegment(taskId)),
					maxHops,
					tokens: feed.tokens,
					tokensPartial: feed.partial,
					events: feed.events,
					sessionId,
					source,
					logFile: `${stem}.log`,
				};
			}),
		);

		const active = entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
		// Running agents first, then most recently active.
		active.sort((a, b) => {
			if (a.running !== b.running) return a.running ? -1 : 1;
			return (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "");
		});
		return Response.json(active);
	}

	/**
	 * Read whatever was appended to one agent feed since the last poll.
	 *
	 * A feed that has grown smaller than our offset was rotated or truncated
	 * (a re-dispatch reusing the path), so the tail is reset rather than fed a
	 * mid-file byte range that would parse as garbage.
	 */
	private async readAgentFeed(
		path: string,
		kind: FeedKind,
	): Promise<{ events: AgentEvent[]; tokens: TokenTotals | null; lastEventAt?: string; partial: boolean }> {
		let tail = this.agentFeeds.get(path);
		if (!tail) {
			tail = new AgentFeedTail(kind);
			this.agentFeeds.set(path, tail);
		}

		let partial = false;
		try {
			const file = Bun.file(path);
			const size = file.size;
			if (size < tail.offset) tail.reset();

			// First attach to an already-huge transcript: skip to the tail instead of
			// parsing megabytes the user will never scroll to. Token totals are then
			// only for the part we read, which `partial` tells the UI to say out loud
			// rather than showing a confidently wrong number.
			const MAX_INITIAL = 8 * 1024 * 1024;
			if (tail.offset === 0 && size > MAX_INITIAL) {
				tail.skipTo(size - MAX_INITIAL);
				partial = true;
			}

			if (size > tail.offset) {
				const chunk = await file.slice(tail.offset, size).text();
				tail.push(chunk, size - tail.offset);
			}
		} catch {
			// Unreadable feed (deleted, locked): keep whatever we already parsed.
		}

		return {
			events: tail.recentEvents(40),
			tokens: tail.tokenTotals().total > 0 ? tail.tokenTotals() : null,
			lastEventAt: tail.lastEventAt(),
			partial,
		};
	}

	private async handleInit(req: Request): Promise<Response> {
		try {
			const body = await req.json();
			const projectName = typeof body.projectName === "string" ? body.projectName.trim() : "";
			const backlogDirectory = typeof body.backlogDirectory === "string" ? body.backlogDirectory.trim() : undefined;
			const backlogDirectorySource =
				body.backlogDirectorySource === "backlog" ||
				body.backlogDirectorySource === ".backlog" ||
				body.backlogDirectorySource === "custom"
					? body.backlogDirectorySource
					: undefined;
			const configLocation =
				body.configLocation === "folder" || body.configLocation === "root" ? body.configLocation : undefined;
			const integrationMode = body.integrationMode as "mcp" | "cli" | "none" | undefined;
			const mcpClients = Array.isArray(body.mcpClients) ? body.mcpClients : [];
			const agentInstructions = Array.isArray(body.agentInstructions) ? body.agentInstructions : [];
			const installClaudeAgentFlag = parseOptionalBoolean(body.installClaudeAgent) ?? false;
			const filesystemOnly = parseOptionalBoolean(body.filesystemOnly) ?? false;
			const advancedConfig = body.advancedConfig || {};

			// Input validation (browser layer responsibility)
			if (!projectName) {
				return Response.json({ error: "Project name is required" }, { status: 400 });
			}

			// Check if already initialized (for browser, we don't allow re-init)
			const existingConfig = await this.core.filesystem.loadConfig();
			if (existingConfig) {
				return Response.json({ error: "Project is already initialized" }, { status: 400 });
			}

			// Call shared core init function
			const result = await initializeProject(this.core, {
				projectName,
				backlogDirectory,
				backlogDirectorySource,
				configLocation,
				integrationMode: integrationMode || "none",
				mcpClients,
				agentInstructions,
				installClaudeAgent: installClaudeAgentFlag,
				filesystemOnly,
				advancedConfig,
				existingConfig: null,
			});

			// Update server's project name
			this.projectName = result.projectName;

			// Ensure config watcher is set up now that config file exists
			if (this.contentStore) {
				this.contentStore.ensureConfigWatcher();
			}

			return Response.json({
				success: result.success,
				projectName: result.projectName,
				mcpResults: result.mcpResults,
			});
		} catch (error) {
			console.error("Error initializing project:", error);
			const message = error instanceof Error ? error.message : "Failed to initialize project";
			return Response.json({ error: message }, { status: 500 });
		}
	}
}
