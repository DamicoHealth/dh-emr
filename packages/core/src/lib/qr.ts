/**
 * QR code encoder, dependency-free. Byte mode (UTF-8), error correction
 * level M, versions 1 to 20 (up to 666 bytes), mask chosen by the standard
 * penalty rules. Output is a module matrix plus an SVG path for it, so the
 * join-link QR renders inline with no image pipeline and no library.
 *
 * Why 20 versions and not 10: a join link that carries a legacy anon JWT
 * (allowed on purpose, see sync/keys.ts) is around 440 bytes, which needs
 * version 16 at level M. A publishable-key link is roughly 230 bytes
 * (version 11). Level M survives about 15% damage, which covers a smudged
 * screen without bloating the symbol past what an iPad camera reads from
 * another iPad's screen at arm's length.
 *
 * Correctness story (tests/qr.test.ts): the Reed-Solomon stage reproduces
 * two published known-answer vectors (the ISO 18004 Annex I example and the
 * widely reproduced HELLO WORLD 1-M example); the format information
 * reproduces the published 15-bit table; and every produced symbol is read
 * back by an independent decoder in the test (its own function map,
 * unmasking, zigzag read, de-interleave, syndrome check, segment parse).
 * The version tables below were cross-checked against the symbol geometry
 * (raw data modules / 8 == total codewords), which the test also asserts.
 *
 * Conventions: modules[row][col], true = dark. Everything is deterministic:
 * the same text always yields the same symbol.
 */

export interface QrMatrix {
  /** Symbol version 1..20 (size = 17 + 4 * version). */
  version: number
  /** Modules per side, no quiet zone. */
  size: number
  /** The mask pattern applied, 0..7. */
  mask: number
  /** modules[row][col], true = dark. Rows are copied on return; mutate freely. */
  modules: boolean[][]
}

/** The highest version this encoder produces. */
export const QR_MAX_VERSION = 20

/** Thrown message when the text does not fit version 20 at level M. */
export const QR_TOO_LONG_ERROR = 'That text is too long for a QR code at this error correction level.'

// ---------------------------------------------------------------------------
// Tables (ISO/IEC 18004), level M, versions 1..20. Index = version - 1.
// ---------------------------------------------------------------------------

/** Error correction codewords per block, level M. */
const ECC_PER_BLOCK_M: readonly number[] = [
  10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
]

/** Number of error correction blocks, level M. */
const BLOCKS_M: readonly number[] = [
  1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
]

/** Alignment pattern centre coordinates (both axes), per version. */
const ALIGNMENT_POSITIONS: readonly (readonly number[])[] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90],
]

/** Format information: level M is 00; the mask occupies the low three bits. */
const FORMAT_LEVEL_M = 0
const FORMAT_GENERATOR = 0x537
const FORMAT_MASK = 0x5412
const VERSION_GENERATOR = 0x1f25

// ---------------------------------------------------------------------------
// Geometry helpers, exported so the test can cross-check the tables.
// ---------------------------------------------------------------------------

export function qrSize(version: number): number {
  return version * 4 + 17
}

/** Alignment pattern centres for a version (the table, not the formula). */
export function qrAlignmentPositions(version: number): readonly number[] {
  const row = ALIGNMENT_POSITIONS[version - 1]
  if (!row) throw new Error(`QR version ${version} is out of range`)
  return row
}

/** Modules available for data + error correction (everything but function patterns). */
export function qrRawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2
    result -= (25 * numAlign - 10) * numAlign - 55
    if (version >= 7) result -= 36
  }
  return result
}

/** Total codewords (data + EC) a version carries. */
export function qrTotalCodewords(version: number): number {
  return Math.floor(qrRawDataModules(version) / 8)
}

/** Error correction codewords per block at level M. */
export function qrEccPerBlock(version: number): number {
  const n = ECC_PER_BLOCK_M[version - 1]
  if (n === undefined) throw new Error(`QR version ${version} is out of range`)
  return n
}

/** Number of blocks at level M. */
export function qrBlockCount(version: number): number {
  const n = BLOCKS_M[version - 1]
  if (n === undefined) throw new Error(`QR version ${version} is out of range`)
  return n
}

/** Data codewords (before error correction) at level M. */
export function qrDataCodewords(version: number): number {
  return qrTotalCodewords(version) - qrEccPerBlock(version) * qrBlockCount(version)
}

/** Character count field width for byte mode. */
function byteCountBits(version: number): number {
  return version <= 9 ? 8 : 16
}

/** Bytes of byte-mode payload a version holds at level M. */
export function qrByteCapacity(version: number): number {
  return Math.floor((qrDataCodewords(version) * 8 - 4 - byteCountBits(version)) / 8)
}

// ---------------------------------------------------------------------------
// GF(256) with the QR primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11d)
// ---------------------------------------------------------------------------

const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
;(function initGf(): void {
  let x = 1
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255] as number
})()

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return GF_EXP[(GF_LOG[a] as number) + (GF_LOG[b] as number)] as number
}

/** Generator polynomial for n EC codewords: product of (x - a^i), i = 0..n-1. Monic, highest degree first. */
function rsGenerator(n: number): number[] {
  let g: number[] = [1]
  for (let i = 0; i < n; i++) {
    const next: number[] = new Array<number>(g.length + 1).fill(0)
    for (let j = 0; j < g.length; j++) {
      const gj = g[j] as number
      next[j] = (next[j] as number) ^ gj
      next[j + 1] = (next[j + 1] as number) ^ gfMul(gj, GF_EXP[i] as number)
    }
    g = next
  }
  return g
}

/**
 * Reed-Solomon error correction codewords for a data block. Exported for
 * the known-answer tests; not part of the app surface.
 */
export function rsEncode(data: readonly number[], eccLen: number): number[] {
  const gen = rsGenerator(eccLen)
  const rem: number[] = new Array<number>(eccLen).fill(0)
  for (const d of data) {
    const factor = d ^ (rem[0] as number)
    rem.shift()
    rem.push(0)
    for (let j = 0; j < eccLen; j++) {
      rem[j] = (rem[j] as number) ^ gfMul(gen[j + 1] as number, factor)
    }
  }
  return rem
}

// ---------------------------------------------------------------------------
// BCH codes for format and version information
// ---------------------------------------------------------------------------

/** The 15-bit format information word for level M and a mask (masked, ready to place). */
export function qrFormatBits(mask: number): number {
  const data = (FORMAT_LEVEL_M << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * FORMAT_GENERATOR)
  return ((data << 10) | rem) ^ FORMAT_MASK
}

/** The 18-bit version information word (versions 7 and up). */
export function qrVersionBits(version: number): number {
  let rem = version
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * VERSION_GENERATOR)
  return (version << 12) | rem
}

// ---------------------------------------------------------------------------
// Masks
// ---------------------------------------------------------------------------

/** True where the mask pattern flips the module at (row, col). */
export function qrMaskBit(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0
    case 1:
      return row % 2 === 0
    case 2:
      return col % 3 === 0
    case 3:
      return (row + col) % 3 === 0
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0
    case 7:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0
    default:
      throw new Error(`QR mask ${mask} is out of range`)
  }
}

// ---------------------------------------------------------------------------
// Segment -> data codewords
// ---------------------------------------------------------------------------

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function chooseVersion(byteLen: number): number {
  for (let v = 1; v <= QR_MAX_VERSION; v++) {
    if (qrByteCapacity(v) >= byteLen) return v
  }
  throw new Error(QR_TOO_LONG_ERROR)
}

function buildDataCodewords(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = []
  const push = (value: number, n: number): void => {
    for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  push(0b0100, 4) // byte mode
  push(bytes.length, byteCountBits(version))
  for (const b of bytes) push(b, 8)
  const capacity = qrDataCodewords(version) * 8
  push(0, Math.min(4, capacity - bits.length)) // terminator
  while (bits.length % 8 !== 0) bits.push(0)
  let pad = 0xec
  while (bits.length < capacity) {
    push(pad, 8)
    pad ^= 0xec ^ 0x11
  }
  const out: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0
    for (let j = 0; j < 8; j++) b = (b << 1) | (bits[i + j] as number)
    out.push(b)
  }
  return out
}

/** Split into blocks, append EC codewords to each, interleave per the spec. */
function addEccAndInterleave(data: readonly number[], version: number): number[] {
  const numBlocks = qrBlockCount(version)
  const eccLen = qrEccPerBlock(version)
  const rawCodewords = qrTotalCodewords(version)
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks)
  const shortBlockLen = Math.floor(rawCodewords / numBlocks)

  const blocks: number[][] = []
  let k = 0
  for (let i = 0; i < numBlocks; i++) {
    const len = shortBlockLen - eccLen + (i < numShortBlocks ? 0 : 1)
    const dat = data.slice(k, k + len)
    k += len
    const ecc = rsEncode(dat, eccLen)
    const block = [...dat]
    if (i < numShortBlocks) block.push(0) // placeholder, skipped below
    blocks.push(block.concat(ecc))
  }

  const result: number[] = []
  const blockLen = (blocks[0] as number[]).length
  for (let i = 0; i < blockLen; i++) {
    for (let j = 0; j < blocks.length; j++) {
      if (i !== shortBlockLen - eccLen || j >= numShortBlocks) {
        result.push((blocks[j] as number[])[i] as number)
      }
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

class Grid {
  readonly size: number
  readonly modules: boolean[][]
  readonly isFunction: boolean[][]

  constructor(size: number) {
    this.size = size
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
    this.isFunction = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  }

  setFunction(row: number, col: number, dark: boolean): void {
    ;(this.modules[row] as boolean[])[col] = dark
    ;(this.isFunction[row] as boolean[])[col] = true
  }

  get(row: number, col: number): boolean {
    return (this.modules[row] as boolean[])[col] as boolean
  }
}

function drawFinder(g: Grid, cRow: number, cCol: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const r = cRow + dy
      const c = cCol + dx
      if (r < 0 || r >= g.size || c < 0 || c >= g.size) continue
      const dist = Math.max(Math.abs(dx), Math.abs(dy))
      // Rings 0, 1, 3 dark; ring 2 light; ring 4 is the light separator.
      g.setFunction(r, c, dist !== 2 && dist !== 4)
    }
  }
}

function drawAlignment(g: Grid, cRow: number, cCol: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      g.setFunction(cRow + dy, cCol + dx, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }
  }
}

function drawFormatBits(g: Grid, mask: number): void {
  const bits = qrFormatBits(mask)
  const bit = (i: number): boolean => ((bits >>> i) & 1) === 1
  const size = g.size
  // First copy, around the top-left finder (row, col).
  for (let i = 0; i <= 5; i++) g.setFunction(i, 8, bit(i))
  g.setFunction(7, 8, bit(6))
  g.setFunction(8, 8, bit(7))
  g.setFunction(8, 7, bit(8))
  for (let i = 9; i <= 14; i++) g.setFunction(8, 14 - i, bit(i))
  // Second copy, split between the top-right and bottom-left finders.
  for (let i = 0; i <= 7; i++) g.setFunction(8, size - 1 - i, bit(i))
  for (let i = 8; i <= 14; i++) g.setFunction(size - 15 + i, 8, bit(i))
  // The module that is always dark.
  g.setFunction(size - 8, 8, true)
}

function drawVersionBits(g: Grid, version: number): void {
  if (version < 7) return
  const bits = qrVersionBits(version)
  for (let i = 0; i < 18; i++) {
    const bit = ((bits >>> i) & 1) === 1
    const a = g.size - 11 + (i % 3)
    const b = Math.floor(i / 3)
    g.setFunction(b, a, bit) // top-right block: rows 0..5, cols size-11..size-9
    g.setFunction(a, b, bit) // bottom-left block: transposed
  }
}

function drawFunctionPatterns(g: Grid, version: number): void {
  const size = g.size
  for (let i = 0; i < size; i++) {
    g.setFunction(6, i, i % 2 === 0)
    g.setFunction(i, 6, i % 2 === 0)
  }
  drawFinder(g, 3, 3)
  drawFinder(g, 3, size - 4)
  drawFinder(g, size - 4, 3)
  const pos = qrAlignmentPositions(version)
  const last = pos.length - 1
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      // The three that would overlap finder patterns are omitted.
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue
      drawAlignment(g, pos[i] as number, pos[j] as number)
    }
  }
  // Reserve the format areas (mask 0 placeholder) and the version areas.
  drawFormatBits(g, 0)
  drawVersionBits(g, version)
}

/** Place codewords in the zigzag order, skipping function modules. */
function drawCodewords(g: Grid, data: readonly number[]): void {
  const size = g.size
  let i = 0
  const total = data.length * 8
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5 // the vertical timing column is never part of a strip
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const col = right - j
        const upward = ((right + 1) & 2) === 0
        const row = upward ? size - 1 - vert : vert
        if (!(g.isFunction[row] as boolean[])[col] && i < total) {
          const byte = data[i >>> 3] as number
          ;(g.modules[row] as boolean[])[col] = ((byte >>> (7 - (i & 7))) & 1) === 1
          i++
        }
      }
    }
  }
}

function applyMask(g: Grid, mask: number): void {
  for (let row = 0; row < g.size; row++) {
    const mr = g.modules[row] as boolean[]
    const fr = g.isFunction[row] as boolean[]
    for (let col = 0; col < g.size; col++) {
      if (!fr[col] && qrMaskBit(mask, row, col)) mr[col] = !mr[col]
    }
  }
}

// Penalty scoring (ISO 18004 section 8.8.2). Any mask yields a readable
// symbol; the score only picks the one with the fewest reader-confusing
// features, so this stays a faithful but unfussy port of the four rules.
const PENALTY_N1 = 3
const PENALTY_N2 = 3
const PENALTY_N3 = 40
const PENALTY_N4 = 10

/**
 * Run history for rule 3: runs[0] is the most recent run length. The first
 * and last light runs of a line are credited with the quiet zone (the
 * symbol's own width), as the reference scorer does.
 */
function addRun(runs: number[], len: number, size: number): void {
  const first = runs[0] === 0
  runs.pop()
  runs.unshift(first ? len + size : len)
}

/** 1:1:3:1:1 dark-light-dark-light-dark with a 4:1 light run on either side. */
function countFinderPatterns(runs: number[]): number {
  const n = runs[1] as number
  const core =
    n > 0 && runs[2] === n && runs[3] === n * 3 && runs[4] === n && runs[5] === n
  if (!core) return 0
  const a = runs[0] as number
  const b = runs[6] as number
  return (a >= n * 4 && b >= n ? 1 : 0) + (b >= n * 4 && a >= n ? 1 : 0)
}

function terminateAndCount(
  runColor: boolean,
  runLen: number,
  runs: number[],
  size: number,
): number {
  let len = runLen
  if (runColor) {
    addRun(runs, len, size)
    len = 0
  }
  addRun(runs, len + size, size)
  return countFinderPatterns(runs)
}

/** Rules 1 and 3 along one line of modules, read through `at`. */
function linePenalty(size: number, at: (i: number) => boolean): number {
  let result = 0
  let runColor = false
  let runLen = 0
  const runs = [0, 0, 0, 0, 0, 0, 0]
  for (let i = 0; i < size; i++) {
    if (at(i) === runColor) {
      runLen++
      if (runLen === 5) result += PENALTY_N1
      else if (runLen > 5) result++
    } else {
      addRun(runs, runLen, size)
      if (!runColor) result += countFinderPatterns(runs) * PENALTY_N3
      runColor = at(i)
      runLen = 1
    }
  }
  result += terminateAndCount(runColor, runLen, runs, size) * PENALTY_N3
  return result
}

function penaltyScore(g: Grid): number {
  const size = g.size
  let result = 0

  for (let row = 0; row < size; row++) result += linePenalty(size, (col) => g.get(row, col))
  for (let col = 0; col < size; col++) result += linePenalty(size, (row) => g.get(row, col))
  // Rule 2: 2x2 blocks of one colour.
  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      const c = g.get(row, col)
      if (c === g.get(row, col + 1) && c === g.get(row + 1, col) && c === g.get(row + 1, col + 1)) {
        result += PENALTY_N2
      }
    }
  }
  // Rule 4: dark proportion away from 50%.
  let dark = 0
  for (const row of g.modules) for (const m of row) if (m) dark++
  const total = size * size
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1
  result += k * PENALTY_N4
  return result
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Encode text (UTF-8) as a level-M QR symbol in the smallest version that
 * fits. Throws QR_TOO_LONG_ERROR past version 20.
 */
export function encodeQr(text: string): QrMatrix {
  const bytes = utf8(text)
  const version = chooseVersion(bytes.length)
  const g = new Grid(qrSize(version))
  drawFunctionPatterns(g, version)
  drawCodewords(g, addEccAndInterleave(buildDataCodewords(bytes, version), version))

  // Pick the mask with the lowest penalty. Apply, score, undo (XOR is its
  // own inverse); then apply the winner for good.
  let best = 0
  let bestScore = Number.POSITIVE_INFINITY
  for (let mask = 0; mask < 8; mask++) {
    applyMask(g, mask)
    drawFormatBits(g, mask)
    const score = penaltyScore(g)
    if (score < bestScore) {
      bestScore = score
      best = mask
    }
    applyMask(g, mask)
  }
  applyMask(g, best)
  drawFormatBits(g, best)

  return {
    version,
    size: g.size,
    mask: best,
    modules: g.modules.map((row) => [...row]),
  }
}

export interface QrSvgPath {
  /** The `d` attribute drawing every dark module as a unit square. */
  d: string
  /** Side length of the viewBox: size plus the quiet zone on both sides. */
  viewSize: number
}

/**
 * The dark modules as one SVG path, offset by a quiet zone (4 modules is
 * the standard minimum). Render as
 * <svg viewBox="0 0 {viewSize} {viewSize}"><path d={d} /></svg>.
 */
export function qrSvgPath(matrix: QrMatrix, quietZone = 4): QrSvgPath {
  const parts: string[] = []
  for (let row = 0; row < matrix.size; row++) {
    const r = matrix.modules[row] as boolean[]
    let col = 0
    while (col < matrix.size) {
      if (!r[col]) {
        col++
        continue
      }
      // Merge horizontal runs into one rectangle to keep the path short.
      let end = col
      while (end + 1 < matrix.size && r[end + 1]) end++
      parts.push(`M${col + quietZone},${row + quietZone}h${end - col + 1}v1h-${end - col + 1}z`)
      col = end + 1
    }
  }
  return { d: parts.join(''), viewSize: matrix.size + quietZone * 2 }
}
