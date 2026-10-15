/// <reference path="./loro-wasm.d.ts" />

import { readFile } from "../fs/resilient"
import type { LoroDoc } from "loro-crdt"

import wasmPath from "loro-crdt/bundler/loro_wasm_bg.wasm" with { type: "file" }

/**
 * The sync engine's single Loro entry point. The stock `loro-crdt` bundler entry locates
 * `loro_wasm_bg.wasm` through `import.meta.url` and fetches it, which has no meaningful URL
 * inside a `bun build --compile` binary ($bunfs) or the desktop engine host bundle. Importing
 * the wasm with the `file` loader makes Bun embed the asset into every bundle and compiled
 * binary at build time and yields a path that node:fs can read in every runtime, so the loader
 * never reaches the network or an unresolved URL for it.
 *
 * The instantiation mirrors the package's own finalize sequence (`loro-crdt/bundler/loro_wasm.js`):
 * hand the exports to the glue through `__wbg_set_wasm`, then run `__wbindgen_start` when present.
 * There is deliberately no fallback path: a Loro that cannot initialize fails loudly here, since
 * memory merges must never silently degrade to a different CRDT.
 */

export interface LoroRuntime {
  readonly LoroDoc: typeof LoroDoc
}

type WasmExports = Record<string, unknown>
type WasmImports = NonNullable<Parameters<typeof WebAssembly.instantiate>[1]>

interface LoroWasmGlue extends LoroRuntime {
  readonly __wbg_set_wasm: (exports: WasmExports) => void
}

let pending: Promise<LoroRuntime> | undefined

async function instantiate(): Promise<LoroRuntime> {
  const glue = (await import("loro-crdt/bundler/loro_wasm_bg.js")) as unknown as LoroWasmGlue
  // The import-object key is part of the wasm binary's import section; it must match exactly.
  // The file loader points at the embedded asset inside a compiled binary ($bunfs) and at the
  // installed package file in every other runtime; node:fs reads both transparently.
  const bytes = await readFile(wasmPath)
  const { instance } = await WebAssembly.instantiate(bytes, {
    "./loro_wasm_bg.js": glue,
  } as unknown as WasmImports)
  const exports = instance.exports as WasmExports & { __wbindgen_start?: () => void }
  glue.__wbg_set_wasm(exports)
  if (typeof exports.__wbindgen_start === "function") exports.__wbindgen_start()
  return glue
}

export function loadLoroRuntime(): Promise<LoroRuntime> {
  pending ??= instantiate()
  return pending
}
