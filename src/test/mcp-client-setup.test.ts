import { describe, expect, it } from "bun:test";
import {
	formatMcpClientSetupCommand,
	getMcpClientSetupCommand,
	runMcpClientSetupCommand,
} from "../utils/mcp-client-setup.ts";

describe("MCP client setup commands", () => {
	it("uses Codex's stdio command separator", () => {
		const setup = getMcpClientSetupCommand("codex", "backlog");

		expect(setup).toEqual({
			label: "OpenAI Codex",
			command: "codex",
			args: ["mcp", "add", "backlog", "--", "backlog", "mcp", "start"],
		});
		expect(formatMcpClientSetupCommand(setup.command, setup.args)).toBe("codex mcp add backlog -- backlog mcp start");
	});

	it("fails when a setup command exits non-zero", async () => {
		await expect(
			runMcpClientSetupCommand("bun", ["-e", "console.error('setup failed'); process.exit(42)"]),
		).rejects.toThrow("Command exited with code 42: setup failed");
	});

	it("treats an already-registered server as success", async () => {
		// `claude mcp add` exits 1 with "MCP server <name> already exists in
		// <scope> config" when the server is registered, and the README tells you
		// to run `backlog init` again on a machine that is already set up. Without
		// this, that documented flow reports "Unable to configure Claude Code
		// automatically" on exactly the machines where it had already worked.
		await expect(
			runMcpClientSetupCommand("bun", [
				"-e",
				"console.error('MCP server backlog already exists in user config'); process.exit(1)",
			]),
		).resolves.toBeUndefined();
	});
});
