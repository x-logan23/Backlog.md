import { describe, expect, it } from "bun:test";
import { AGENT_LOOP_STATUSES } from "../constants/agent-loop-templates.ts";
import { getTerminalStatus } from "../utils/terminal-status.ts";

// The dispatch loop's statuses are ordered, and two positions in that order are
// load-bearing in ways nothing else would catch: breaking either one changes
// behaviour silently, with no type error and no failing assertion elsewhere.
describe("AGENT_LOOP_STATUSES", () => {
	it("keeps Done last, so terminal-status cleanup still means 'finished'", () => {
		// getTerminalStatus() is defined as the final entry, and that is what
		// getTerminalStatusTasksByAge() archives by age and what the board's cleanup
		// affordance hangs off. Appending anything after Done -- Blocked was very
		// nearly appended after it -- points the cleanup at the wrong column and
		// stops it ever archiving finished work.
		expect(getTerminalStatus(AGENT_LOOP_STATUSES)).toBe("Done");
	});

	it("ships Blocked, which the dispatcher's loop guard parks fenced tasks in", () => {
		// dispatch.ps1/.sh run `backlog task edit <id> -s Blocked` when a task
		// exhausts its coder/reviewer hops. That fails on a project whose statuses
		// have no Blocked, and the task stays fenced in place with only a log line
		// to say so -- the exact invisibility the column was added to fix.
		expect(AGENT_LOOP_STATUSES).toContain("Blocked");
	});
});
