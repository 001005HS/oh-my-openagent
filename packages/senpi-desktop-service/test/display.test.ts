import { afterEach, describe, expect, it } from "vitest";
import { runComputerCode } from "../src/run/runtime";
import { DesktopService } from "../src/service/service";
import { fakeEngineFactory } from "./harness";

const services: DesktopService[] = [];
afterEach(async () => {
	await Promise.all(services.splice(0).map((service) => service.close()));
});

async function open() {
	const log = fakeEngineFactory({ FAKE_ENGINE_DESKTOP: "1" });
	const service = new DesktopService({ createChild: log.factory });
	services.push(service);
	await service.open({});
	const run = (code: string, readOnly = false) =>
		runComputerCode(
			{
				code,
				timeoutMs: 5_000,
				snapshot: {
					cwd: "/work", sessionId: "display-test", captureMaxWidth: 3840,
					captureMaxHeight: 2400, captureMaxBytes: 5_000_000, display: "active",
					readOnly, stopHotkey: "ctrl+alt+shift+escape", allowHostRelayOnlyStop: false,
				},
			},
			{ service, executeTool: async () => undefined },
		);
	return { log, run };
}

describe("display handles", { timeout: 30_000 }, () => {
	it.each(["1", "active", "all"])("routes capture and input to display:%s without changing the root", async (selector) => {
		// Given
		const { log, run } = await open();
		// When
		const result = await run(`
			const display = await desktop.display(${JSON.stringify(selector)});
			await display.screenshot({ silent: true });
			await display.click(20, 10);
			await desktop.screenshot({ silent: true });
			return display.id;
		`);
		// Then
		expect(result.returnValue).toBe(selector);
		expect(log.requests.filter((request) => request.method === "capture").map((request) => request.params))
			.toEqual([
				expect.objectContaining({ target: `display:${selector}` }),
				expect.objectContaining({ target: "desktop" }),
			]);
		expect(log.requests.find((request) => request.method === "click")?.params)
			.toEqual({ target: `display:${selector}`, x: 20, y: 10, opts: {} });
		expect(log.requests.some((request) => request.method === "displays")).toBe(selector === "1");
	});

	it("refuses an unknown id before capture", async () => {
		// Given
		const { log, run } = await open();
		// When
		const result = run(`await desktop.display("missing");`);
		// Then
		await expect(result).rejects.toThrow("Unknown display: missing");
		expect(log.requests.some((request) => request.method === "capture")).toBe(false);
	});

	it.each(["", null, 2])("refuses invalid selector %s", async (selector) => {
		// Given
		const { run } = await open();
		// When
		const result = run(`await desktop.display(${JSON.stringify(selector)});`);
		// Then
		await expect(result).rejects.toThrow("display requires an id, 'active', or 'all'");
	});

	it("permits display capture in a read-only run", async () => {
		// Given
		const { run } = await open();
		// When
		const result = await run(`return (await (await desktop.display("all")).screenshot({ silent: true })).target;`, true);
		// Then
		expect(result.returnValue).toBe("display:all");
	});

	it("refuses display input in a read-only run", async () => {
		// Given
		const { log, run } = await open();
		// When
		const result = run(`await (await desktop.display("active")).click(1, 1);`, true);
		// Then
		await expect(result).rejects.toThrow("read-only run: 'click'");
		expect(log.requests.some((request) => request.method === "click")).toBe(false);
	});
});
