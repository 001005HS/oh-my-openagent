import { expect, test } from "bun:test"
import { join } from "node:path"

const repoRoot = join(import.meta.dir, "../../../..")
const fixture = "./packages/isolation-core/src/merge/abandoned-concurrent-merge.fixture.ts"

test("a concurrent-merge test that times out leaves no running merge and no unhandled error for the next test (#9846, #9678)", async () => {
  const run = Bun.spawn([process.execPath, "test", fixture], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
  const output = stdout + stderr
  expect(output).toContain("(fail) abandoned:")
  expect(output).toContain("(pass) neighbor:")
  expect(output).not.toContain("Unhandled error")
  expect(exitCode).toBe(1)
})
