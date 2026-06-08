import { describe, expect, test } from "bun:test"
import { parsePatch } from "diff"
import { preview } from "../../src/tool/fileaction-diff"

describe("fileaction diff preview", () => {
  test("repairs stale hunk counts before rendering", () => {
    const text = [
      "--- rockchip_amp.c",
      "+++ rockchip_amp.c",
      "@@ -251,3 +251,10 @@",
      " \tamp_trace(0x3000, entry_point);",
      " \tamp_trace(0x3001, data_size);",
      " ",
      "+\tif (entry_point == RK3506_AP_LOAD_BASE) {",
      "+\t\treserve_base = RK3506_AMP_DDR_BASE;",
      "+\t\treserve_size = RK3506_AMP_DDR_SIZE;",
      "+\t\tamp_trace(0x3003, reserve_base);",
      "+\t\tamp_trace(0x3004, reserve_size);",
      "+\t}",
      "+",
      " \tif (!sysmem_alloc_base_by_name(id,",
    ].join("\n")

    const diff = preview({ mode: "patch", patchText: text }, "rockchip_amp.c")

    expect(diff).toContain("@@ -251,4 +251,11 @@")
    expect(() => parsePatch(diff)).not.toThrow()
  })

  test("repairs hunk-only file action counts", () => {
    const text = [
      "@@ -382,5 +382,16 @@",
      " \t\tsetup_sync_bits_for_linux();",
      " \t} else {",
      "+\t\tphys_addr_t reserve_base = (phys_addr_t)load;",
      "+\t\tphys_size_t reserve_size = data_size;",
      "+",
      "+\t\tif (load == RK3506_AP_LOAD_BASE) {",
      "+\t\t\treserve_base = RK3506_AMP_DDR_BASE;",
      "+\t\t\treserve_size = RK3506_AMP_DDR_SIZE;",
      "+\t\t\tamp_trace(0x2003, reserve_base);",
      "+\t\t\tamp_trace(0x2004, reserve_size);",
      "+\t\t}",
      "+",
      " \t\tif (!sysmem_alloc_base_by_name(desc,",
      "-\t\t\t\t(phys_addr_t)load, data_size)) {",
      "+\t\t\t\treserve_base, reserve_size)) {",
      " \t\t\tamp_trace(0x20e2, load);",
    ].join("\n")

    const diff = preview({ mode: "patch", patchText: text }, "rockchip_amp.c")

    expect(diff).toContain("@@ -382,5 +382,15 @@")
    expect(() => parsePatch(diff)).not.toThrow()
  })

  test("builds a valid diff for hunk-only patch text", () => {
    const diff = preview({ mode: "patch", patchText: "@@ -1,1 +1,1 @@\n-old\n+new" }, "small.txt")

    expect(diff).toBe("--- small.txt\n+++ small.txt\n@@ -1,1 +1,1 @@\n-old\n+new")
    expect(() => parsePatch(diff)).not.toThrow()
  })
})
