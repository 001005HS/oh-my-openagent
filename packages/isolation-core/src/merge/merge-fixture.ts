import { onTestFinished } from "bun:test"
import { cp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { repo } from "../backends/git-fixture"
import { captureBaseline } from "../git/baseline"
import { mergeIsolatedChanges } from "./index"

export async function setup(nested = false) {
  const f = await repo()
  if (nested) {
    const inner = await repo()
    await cp(inner.repoRoot, join(f.repoRoot, "inner"), { recursive: true })
  }
  const baseline = await captureBaseline(f.repoRoot)
  const isolationDir = join(f.root, "child")
  await cp(f.repoRoot, isolationDir, { recursive: true })
  const options = { ...f, baseline, isolationDir, id: "test", artifactsDir: join(f.root, "artifacts"), apply: true, mode: "patch" as const }
  return options
}

type Gates = { readonly release: PromiseWithResolvers<void>; readonly own: <T>(work: Promise<T>) => Promise<T> }

async function concurrentMerges(mode: "patch" | "branch", { release, own }: Gates) {
  const f = await setup()
  await writeFile(join(f.isolationDir, "one"), "one\n")
  const other = join(f.root, "other")
  await cp(f.repoRoot, other, { recursive: true })
  await writeFile(join(other, "two"), "two\n")
  const entered = Promise.withResolvers<void>()
  const queued = Promise.withResolvers<void>()
  const events: string[] = []
  const first = own(mergeIsolatedChanges({ ...f, mode, lockHook: async event => {
    events.push(`first:${event}`)
    if (event === "acquired") { entered.resolve(); await release.promise }
  } }))
  await entered.promise
  const second = own(mergeIsolatedChanges({ ...f, mode, id: "second", isolationDir: other, lockHook: event => {
    events.push(`second:${event}`)
    if (event === "waiting") queued.resolve()
  } }))
  await queued.promise
  return { f, first, second, events }
}

/** Starts two merges of one repository, the first held at "acquired" until `release()`. Every git call it makes is owned by the
 * calling test: if the test times out, its teardown releases the hold and waits for setup and both merges to settle before the
 * fixture tree is removed, so no git child outlives the test and no rejection lands on the next test (#9846, #9678). */
export function startConcurrentMerges(mode: "patch" | "branch") {
  const release = Promise.withResolvers<void>()
  const work: Promise<unknown>[] = []
  let pending = 0
  const own = <T>(promise: Promise<T>) => {
    pending++
    work.push(promise)
    promise.then(() => { pending-- }, () => { pending-- })
    return promise
  }
  // Registered before setup() registers the fixture's removal: bun runs onTestFinished callbacks in registration order.
  onTestFinished(async () => {
    release.resolve()
    for (let settled = 0; settled < work.length; settled++) await Promise.allSettled([work[settled]])
  })
  const ready = own(concurrentMerges(mode, { release, own }))
  return { ready, release: () => release.resolve(), settled: () => pending === 0 }
}
