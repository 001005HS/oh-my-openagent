/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"

import { isFullAccess } from "./full-access"

function source(flag: boolean | string | undefined, settings?: unknown) {
  return { getFlag: () => flag, ...(settings === undefined ? {} : { getSettings: () => settings }) }
}

describe("isFullAccess (#10022)", () => {
  test.each([
    ["the session flag is full-access", source("full-access"), true],
    ["the session flag is another preset", source("workspace"), false],
    ["the session flag overrides a full-access setting", source("ask", { permissionPreset: "full-access" }), false],
    ["no flag, full-access in settings", source(undefined, { permissionPreset: "full-access" }), true],
    ["no flag, another preset in settings", source(undefined, { permissionPreset: "workspace" }), false],
    ["no flag and no settings", source(undefined), false],
  ])("#given %s #then it reports %p", (_name, preset, expected) => {
    expect(isFullAccess(preset)).toBe(expected)
  })
})
