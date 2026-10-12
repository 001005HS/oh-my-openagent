/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"

import { isFullAccess, watchFullAccess } from "./full-access"

function source(flag: boolean | string | undefined) {
  return { getFlag: () => flag, getSettings: () => ({ permissionPreset: "full-access" }) }
}

describe("isFullAccess (#10022)", () => {
  test.each([
    ["the session flag is full-access", source("full-access"), true],
    ["the session flag is another preset", source("ask"), false],
    ["no session flag, even with full-access in settings (a task child, an untrusted project)", source(undefined), false],
  ])("#given %s #then it reports %p", (_name, preset, expected) => {
    expect(isFullAccess(preset)).toBe(expected)
  })
})

describe("watchFullAccess (#10022)", () => {
  test("#given a host without flags #when registering #then it never counts as full access", () => {
    // given
    const host: Parameters<typeof watchFullAccess>[0] = {}

    // when
    const fullAccess = watchFullAccess(host)

    // then
    expect(fullAccess()).toBe(false)
  })
})
