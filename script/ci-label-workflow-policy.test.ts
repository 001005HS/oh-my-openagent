/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { load } from "js-yaml"

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("workflow field must be an object")
  }
  return value as Record<string, unknown>
}

function workflow(name: string): Record<string, unknown> {
  return record(load(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8")))
}

// GitHub Actions trigger and concurrency contracts protect required check runs.
describe("#given required CI and an optional full-matrix label run", () => {
  test("#then normal CI excludes labels and remains reusable", () => {
    const triggers = record(workflow("ci.yml")["on"])
    expect(record(triggers["pull_request"])["types"]).toEqual(["opened", "synchronize", "reopened"])
    expect(triggers).toHaveProperty("workflow_call")
  })

  test("#then only the full-matrix label can call CI in a separate concurrency group", () => {
    const ci = workflow("ci.yml")
    const caller = workflow("ci-full-matrix-label.yml")
    const triggers = record(caller["on"])
    expect(Object.keys(triggers)).toEqual(["pull_request"])
    expect(record(triggers["pull_request"])["types"]).toEqual(["labeled"])

    const jobs = record(caller["jobs"])
    expect(Object.keys(jobs)).toEqual(["full-matrix"])
    const job = record(jobs["full-matrix"])
    expect(job["if"]).toBe("github.event.label.name == 'ci:full-matrix'")
    expect(job["uses"]).toBe("./.github/workflows/ci.yml")
    expect(job["secrets"]).toBe("inherit")
    expect(caller["permissions"]).toEqual({ contents: "write", "pull-requests": "write" })

    const concurrency = record(caller["concurrency"])
    expect(concurrency["group"]).toBe("${{ github.workflow }}-pr-${{ github.event.pull_request.number }}-full-matrix")
    expect(concurrency["cancel-in-progress"]).toBe(true)
    expect(record(ci["concurrency"])["group"]).toBe("${{ github.workflow }}-${{ github.ref }}")
    expect(concurrency["group"]).not.toBe(record(ci["concurrency"])["group"])
  })
})
