import { describe, expect, it } from "bun:test";
import { JSDOM } from "jsdom";
import { renderToString } from "react-dom/server";
import type { Task } from "../types/index.ts";
import { TaskDetailsModal } from "../web/components/TaskDetailsModal";
import { ThemeProvider } from "../web/contexts/ThemeContext";

const setupDom = () => {
	const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
	globalThis.window = dom.window as unknown as Window & typeof globalThis;
	globalThis.document = dom.window.document as Document;
	globalThis.navigator = dom.window.navigator as Navigator;
	globalThis.localStorage = dom.window.localStorage;

	if (!window.matchMedia) {
		window.matchMedia = () =>
			({
				matches: false,
				media: "",
				onchange: null,
				addListener: () => {},
				removeListener: () => {},
				addEventListener: () => {},
				removeEventListener: () => {},
				dispatchEvent: () => false,
			}) as MediaQueryList;
	}
};

const makeTask = (overrides: Partial<Task> = {}): Task => ({
	id: "TASK-1",
	title: "Sample",
	status: "To Do",
	assignee: [],
	createdDate: "2026-01-01",
	labels: [],
	dependencies: [],
	...overrides,
});

const renderModal = (task: Task) => {
	setupDom();
	return renderToString(
		<ThemeProvider>
			<TaskDetailsModal task={task} isOpen={true} onClose={() => {}} />
		</ThemeProvider>,
	);
};

describe("Web task popup Repository field", () => {
	it("renders the Repository section", () => {
		expect(renderModal(makeTask())).toContain("Repository");
	});

	it("shows the task's repo as the input value", () => {
		expect(renderModal(makeTask({ repo: "payments-api" }))).toContain('value="payments-api"');
	});

	it("shows a nested repo path", () => {
		expect(renderModal(makeTask({ repo: "platform/billing" }))).toContain('value="platform/billing"');
	});

	it("leaves the input empty for a task with no repo", () => {
		const html = renderModal(makeTask());
		// The section still renders (so a repo can be assigned), but carries no value.
		expect(html).toContain("Repository");
		expect(html).not.toContain('value="payments-api"');
	});
});
