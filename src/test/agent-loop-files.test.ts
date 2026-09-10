import { describe, expect, it } from "bun:test";
import { buildAgentLoopFiles } from "../constants/agent-loop-templates.ts";

describe("buildAgentLoopFiles", () => {
	const claudeConfigs = [".claude/mcp-coder.json", ".claude/mcp-reviewer.json"];

	it("ships the Claude Code MCP configs by default", () => {
		const paths = buildAgentLoopFiles("backlog").map((f) => f.path);
		for (const c of claudeConfigs) expect(paths).toContain(c);
	});

	it("omits them when the project opted out of AI integration", () => {
		// `integrationMode: "none"` means "no AI setup". Writing the client wiring
		// anyway left every such project with an untracked `.claude/` that nothing
		// staged, ignored or explained -- which showed up as ten test failures
		// asserting isClean() after an auto-commit, none of them about .claude at all.
		const paths = buildAgentLoopFiles("backlog", false).map((f) => f.path);
		for (const c of claudeConfigs) expect(paths).not.toContain(c);
	});

	it("still ships the loop itself when the client configs are omitted", () => {
		// The dispatcher and prompts are the fork's reason to exist; opting out of
		// client wiring must not take them with it.
		const paths = buildAgentLoopFiles("backlog", false).map((f) => f.path);
		expect(paths).toContain("backlog/prompts/dispatch.ps1");
		expect(paths).toContain("backlog/prompts/dispatch.sh");
		expect(paths).toContain("backlog/prompts/watchdog.ps1");
	});

	it("honours a custom backlog directory", () => {
		const paths = buildAgentLoopFiles(".backlog").map((f) => f.path);
		expect(paths).toContain(".backlog/prompts/dispatch.ps1");
	});
});
