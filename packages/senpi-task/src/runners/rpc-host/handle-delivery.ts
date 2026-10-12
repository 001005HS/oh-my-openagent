import type { RunnerOutcome } from "../in-process/child-handle"
import { isBusyChildRejection, type RpcStreamingBehavior } from "../rpc/delivery-semantics"
import { promptFailureOutcome } from "../rpc/turn-outcome"
import type { HostSessionCommand } from "./session-client"

/** The host handle's input delivery, including the existing busy-to-followUp retry. */
export function createHostDelivery(input: {
  readonly beginTurn: () => void
  readonly issue: (command: HostSessionCommand) => Promise<void>
  readonly settle: (outcome: RunnerOutcome) => void
}) {
  const deliverPrompt = async (text: string, streamingBehavior: RpcStreamingBehavior): Promise<void> => {
    try {
      await input.issue({ type: "prompt", message: text, streamingBehavior })
    } catch (error) {
      if (streamingBehavior === "followUp" || !isBusyChildRejection(error)) throw error
      await input.issue({ type: "prompt", message: text, streamingBehavior: "followUp" })
    }
  }
  return {
    runPrompt: async (text: string, streamingBehavior: RpcStreamingBehavior = "steer"): Promise<void> => {
      input.beginTurn()
      try {
        await deliverPrompt(text, streamingBehavior)
      } catch (error) {
        input.settle(promptFailureOutcome(error))
        throw error
      }
    },
    steer: async (text: string): Promise<void> => {
      input.beginTurn()
      try {
        await input.issue({ type: "steer", message: text })
      } catch (error) {
        if (!isBusyChildRejection(error)) throw error
        await deliverPrompt(text, "followUp")
      }
    },
  }
}
