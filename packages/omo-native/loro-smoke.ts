// `omo loro-smoke` self-checks that the pinned Loro runtime initializes inside this compiled
// binary and still reproduces the committed wire encodings. The import literal pulls the
// memory-core loader - and with it the embedded loro wasm - into the compiled graph.
const LORO_SMOKE_UPDATE_HEX = "6c6f726f00000000000000000000000099c57bf400045400070007011001070000000000000001010000000000050100000100060104010200000504626f6479001401040206000405000200040505090504010504010b0103020100020102020102080568656c6c6f0161"
const LORO_SMOKE_SHALLOW_HEX = "6c6f726f00000000000000000000000019a103c70003960000004c4f524f000601060101110107000000000000000001010000000000050100000100060104010200000504626f6479000e010402010002010202010502010100020161000200667201070c000200736601070c000200737601070c000200767601070e00003e0046004e0056000500ddc812f001000000050000000c0000000000000000070000000600020076765e71e78f7300000001000000455e0000004c4f524f0001070c0006008204626f64790201000568616c6c6f01070000000000000003040206000405000c0702060004050200040000000003000200d2d8c9690100000005000000020066720006008204626f64792740183341000000"

function hexOf(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex")
}

export async function runLoroSmoke(): Promise<number> {
  const { loadLoroRuntime } = await import("../memory-core/src/crdt/loro-runtime")
  const { LoroDoc } = await loadLoroRuntime()
  const doc = new LoroDoc()
  try {
    doc.setPeerId("7")
    doc.setRecordTimestamp(false)
    doc.getText("body").insert(0, "hello")
    doc.commit({ timestamp: 0 })
    doc.getText("body").delete(1, 1)
    doc.getText("body").insert(1, "a")
    doc.commit({ timestamp: 0 })
    if (doc.getText("body").toString() !== "hallo") throw new Error("edit sequence did not render hallo")
    const updateHex = hexOf(doc.export({ mode: "update" }))
    const shallowHex = hexOf(doc.export({ mode: "shallow-snapshot", frontiers: doc.oplogFrontiers() }))
    if (updateHex !== LORO_SMOKE_UPDATE_HEX) throw new Error("update encoding drifted from the committed fixture")
    if (shallowHex !== LORO_SMOKE_SHALLOW_HEX) throw new Error("shallow-snapshot encoding drifted from the committed fixture")
  } finally {
    doc.free()
  }
  console.log(`loro-smoke ok: runtime initialized, edits applied, encodings match loro-crdt 1.16.4 (${LORO_SMOKE_UPDATE_HEX.length / 2}-byte update, ${LORO_SMOKE_SHALLOW_HEX.length / 2}-byte shallow snapshot)`)
  return 0
}
