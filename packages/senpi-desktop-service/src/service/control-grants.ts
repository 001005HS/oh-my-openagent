import type { EngineMethod } from "@oh-my-opencode/senpi-desktop-protocol";
import { DesktopEngineRpcError, DesktopServiceError } from "./rpc-client";
import type { Connection } from "./session-state";
import { REVOKE_TIMEOUT_MS } from "./timeouts";

/** Tracks grants that may still need the best-effort B5b revoke. */
export class ControlGrantLedger {
	#sent = 0;
	#revoked = 0;

	beforeRequest(method: EngineMethod): number {
		// Count before send: a grant whose reply is lost to cancellation may still be live.
		if (method === "control.grant") this.#sent += 1;
		return this.#sent;
	}

	afterSuccess(method: EngineMethod, covers: number): void {
		if (method === "control.revoke") this.#revoked = Math.max(this.#revoked, covers);
	}

	revoke(connection: Connection | undefined, report: (error: Error) => void): Promise<void> {
		if (connection === undefined || !connection.rpc.alive || this.#sent <= this.#revoked) {
			return Promise.resolve();
		}
		const covers = this.#sent;
		return connection.rpc.request("control.revoke", {}, { timeoutMs: REVOKE_TIMEOUT_MS }).then(
			() => this.afterSuccess("control.revoke", covers),
			(error: unknown) => {
				if (error instanceof DesktopServiceError || error instanceof DesktopEngineRpcError) {
					report(error);
					return;
				}
				throw error;
			},
		);
	}
}
