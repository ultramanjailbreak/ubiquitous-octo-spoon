// ps4_offsets.js -- RAW GAME 13.52-ONLY offset table.
//
// This build supports EXACTLY ONE firmware: PS4 13.52 (the last retail FW).
// Every other entry that shipped in the multi-firmware table has been removed,
// so an unlisted console can never reach the primitive by accident -- the UI
// gate and offsetsFor() now agree on a single target by construction.
//
// The 13.52 values are INLINED here (they are NOT derived from another entry
// at runtime any more). They are byte-for-byte the values the multi-firmware
// build resolved for "13.52" -- the webkit + libkernel set and the measured
// kernel RVAs are unchanged, only the sourcing is now static.
//
// The PS4 reports its minor version as two hex digits in the UA:
//   "PlayStation 4/13.52"  ->  13.52 decimal  ->  minor 0x52
//   "PlayStation 4/13.50"  ->  13.50 decimal  ->  minor 0x50
// so a UA of /13.52 is a genuine 13.52 and a UA of /13.5A is a 13.50.

// Keys the loader must find before it will touch the kernel. Unused by the
// loader at runtime (it is a self-documenting contract) -- kept so a future
// table edit that drops a name is caught by review, not by a console reboot.
export const REQUIRED_KEYS = [
  "fw_status",
  "wk_expm1_builtin",
  "wk_JSFunction_m_function",
  "wk_POP_RDI_RET",
  "wk_POP_RSI_RET",
  "wk_POP_RDX_RET",
  "wk_POP_RCX_RET",
  "wk_POP_RAX_RET",
  "wk_POP_R8_RET",
  "wk_POP_R9_RET",
  "wk_LEAVE_RET",
  "wk_MOV_QWORD_PTR_RDI_RAX_RET",
  "wk_MOV_RDI_RSI_30_CALL",
  "wk_POP_RAX_MOV_RAX_JMP_18",
  "wk_PUSH_RBP_MOV_RBP_RSP_10",
  "wk_MOV_RDI_RAX_8_CALL_20",
  "wk_MOV_RDX_RAX_18_CALL_10",
  "wk_PUSH_RDX_POP_RSP_RET",
  "pivot_view_sp",
  "wk_ArrayBuffer_m_impl",
  "wk_ArrayBuffer_m_contents_m_data",
  "wk___imp___error",
  "k__error",
  "k_scan_stage1",
  "k_scan_stage2",
  "k_evf_cv",
  "k_sysent_661",
  "k_jmp_rsi",
];

// Present for the jailbreak / kpatch / payload stages. Absence of any of these
// stops the run before a kernel write.
export const OPTIONAL_KEYS = [
  "k_stubs",
  "wk___imp_pthread_create",
  "k_pthread_create",

  "kpatch",

  "payload",

  "k_idt_rsvd",
];

// The only firmware this build knows how to run.
export const SUPPORTED_FW = "13.52";

export const PS4 = {
  "13.52": {
    fw_status:
      "state=663-LIVE-on-hardware shares=13.50 (webkit+libkernel) " +
      "kernel_rvas=MEASURED-from-kernel_1352.elf (kdump5 tier1 36MB pass=39/0, " +
      "kderive 16/16 recipes) kpatch=1352.bin-24-sites-verified-OFFLINE-ONLY " +
      "payload=goldhen.bin-PS4HEN-native-1352 (patched-GoldHEN KP'd 2/2) " +
      "bug=663",

    // ---- WebKit (Safari/JavaScriptCore) module ----
    wk_expm1_builtin: 0x2586880,
    wk_JSFunction_m_function: 0x28,

    wk_POP_RDI_RET: 0x5c480,
    wk_POP_RSI_RET: 0x6e45e,
    wk_POP_RDX_RET: 0x12c5ba,
    wk_POP_RCX_RET: 0x1bade,
    wk_POP_RAX_RET: 0x10504,
    wk_POP_R8_RET: 0x9b311,
    wk_POP_R9_RET: 0x1dcfb1,
    wk_LEAVE_RET: 0x182f7,
    wk_MOV_QWORD_PTR_RDI_RAX_RET: 0x548b,
    wk_PUSH_RDX_POP_RSP_RET: 0x2abccaa,
    wk_MOV_RDI_RSI_30_CALL: 0x295f948,
    wk_POP_RAX_MOV_RAX_JMP_18: 0x1d989e3,
    wk_PUSH_RBP_MOV_RBP_RSP_10: 0x25bae0,
    wk_MOV_RDI_RAX_8_CALL_20: 0x4a0406,
    wk_MOV_RDX_RAX_18_CALL_10: 0x1ec3ada,

    pivot_view_sp: 0x38,
    wk_ArrayBuffer_m_impl: 0x10,
    wk_ArrayBuffer_m_contents_m_data: 0x10,

    wk___imp___error: 0x3cb8cc8,
    k__error: 0x1a0f0,
    wk___imp_pthread_create: 0x3cb9c00,
    k_pthread_create: 0x21790,

    // ---- libkernel syscall page stubs (verified by the mov-imm stub epilogue) ----
    k_stubs: {
      3: 0x2c170,
      4: 0x2b8d0,
      5: 0x2b970,
      6: 0x2d620,
      20: 0x2cb70,
      23: 0x2b6f0,
      24: 0x2d5e0,
      25: 0x2b4d0,
      30: 0x2c9d0,
      54: 0x2cff0,
      92: 0x2b650,
      97: 0x2d050,
      98: 0x2b5f0,
      104: 0x2d380,
      105: 0x2b490,
      106: 0x2d480,
      118: 0x2b2f0,
      135: 0x2c280,
      240: 0x2d4c0,
      331: 0x2c6b0,
      432: 0x2b510,
      466: 0x2cc70,
      487: 0x2ba80,
      488: 0x2bd10,
      538: 0x2b430,
      539: 0x2b4f0,
      544: 0x2beb0,
      545: 0x2ca30,
      632: 0x2d090,
      633: 0x2d840,
      662: 0x2ccb0,
      663: 0x2c3e0,
      664: 0x2d740,
      666: 0x2d540,
      669: 0x2bdf0,
    },
    k_scan_stage1: 0x40000,
    k_scan_stage2: 0x60000,

    // ---- kernel RVAs, measured from kernel_1352.elf ----
    k_idt_rsvd: 0x1c1e00,
    k_sysctl_handle_int: 0x3fa8e0,
    k_jmp_rsi: 0x4d6d0,
    k_kl_lock: 0xe6c60,
    k_evf_cv: 0x785228,
    k_sysent: 0x1102b70,
    k_sysent_661: 0x110a760,
    k_oid_kern_file: 0x1a2f8a0,
    k_oid_maxfilesperproc: 0x1a2f950,
    k_oid_maxprocperuid: 0x1a3ba88,
    k_oid_maxfiles: 0x1a2f9a8,
    k_arg1_maxfilesperproc: 0x22cc47c,
    k_arg1_maxprocperuid: 0x22cc478,
    k_arg1_maxfiles: 0x22cc474,
    k_prison0: 0x1a5c0c0,
    k_rootvnode: 0x2136e90,

    kpatch: "1352.bin",
    payload: "goldhen.bin",
  },
};

// Parse a PS4 user-agent into { key, fwnum, off }.
//   key   "13.52" -- the table key
//   fwnum 1352    -- the compact integer the loader UI gates on
//   off   the 13.52 table, or null for any other firmware.
export function parseUa(uaString) {
  const m = /PlayStation\s+4[\/ ](\d+)\.(\d+)/.exec(uaString || "");
  if (!m) return { key: null, fwnum: null, off: null };

  const minor = parseInt(m[2], 16); // UA minor is hex
  const key = m[1] + "." + minor.toString(16).padStart(2, "0");
  return {
    key: key,
    fwnum: parseInt(m[1], 10) * 100 + minor,
    off: Object.prototype.hasOwnProperty.call(PS4, key) ? PS4[key] : null,
  };
}

// Kept for API compatibility with the multi-firmware build.
export function offsetsFor(uaString) {
  const r = parseUa(uaString);
  return { key: r.key, off: r.off };
}
