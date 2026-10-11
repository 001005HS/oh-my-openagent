import { expect, test } from "bun:test"
import { startConcurrentMerges } from "./merge-fixture"

let abandoned: ReturnType<typeof startConcurrentMerges> | undefined

test("abandoned: times out with its fixture setup and both merges still owed", async () => {
  abandoned = startConcurrentMerges("branch")
  await new Promise<never>(() => {})
}, 50)

test("neighbor: no git work from the abandoned test is still running", () => {
  expect(abandoned).toBeDefined()
  expect(abandoned?.settled()).toBe(true)
})
