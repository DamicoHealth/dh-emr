/**
 * QR encoder (src/lib/qr.ts). A wrong QR is worse than none, so this suite
 * does not trust the encoder's own tables or helpers:
 *  - Reed-Solomon reproduces two PUBLISHED known-answer vectors (the ISO
 *    18004 Annex I "01234567" example and the HELLO WORLD 1-M example);
 *  - the format information reproduces the published 15-bit table;
 *  - the version tables are cross-checked against the symbol geometry and
 *    the published capacity figures;
 *  - every symbol is read back by the decoder below, written from the
 *    specification independently of the encoder: its own function-module
 *    map, explicit format-bit coordinates, its own zigzag walk, its own
 *    de-interleave, a shift-and-add GF(256) with a syndrome check (no
 *    shared tables), then the byte segment is parsed and compared.
 */
import { describe, expect, it } from 'vitest'
import {
  QR_MAX_VERSION,
  QR_TOO_LONG_ERROR,
  encodeQr,
  qrAlignmentPositions,
  qrBlockCount,
  qrByteCapacity,
  qrEccPerBlock,
  qrFormatBits,
  qrMaskBit,
  qrRawDataModules,
  qrSize,
  qrSvgPath,
  qrTotalCodewords,
  qrVersionBits,
  rsEncode,
  type QrMatrix,
} from '../src/lib/qr'

// ---------------------------------------------------------------------------
// Published figures (ISO/IEC 18004 tables 1, 7 and 9, level M)
// ---------------------------------------------------------------------------

const TOTAL_CODEWORDS = [
  26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655, 733, 815, 901, 991,
  1085,
]
const BYTE_CAPACITY_M = [
  14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412, 450, 504, 560, 624,
  666,
]
/** Remainder bits after the last codeword, per version. */
const REMAINDER_BITS = [0, 7, 7, 7, 7, 7, 0, 0, 0, 0, 0, 0, 0, 3, 3, 3, 3, 3, 3, 3]

/** The 15-bit format information strings for level M, masks 0..7. */
const FORMAT_M = [
  '101010000010010',
  '101000100100101',
  '101111001111100',
  '101101101001011',
  '100010111111001',
  '100000011001110',
  '100111110010111',
  '100101010100000',
]

// ---------------------------------------------------------------------------
// Independent GF(256) arithmetic: shift-and-add, no tables
// ---------------------------------------------------------------------------

function gmul(a: number, b: number): number {
  let p = 0
  let x = a
  let y = b
  while (y) {
    if (y & 1) p ^= x
    y >>= 1
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  return p
}

function alphaPow(e: number): number {
  let r = 1
  for (let i = 0; i < e; i++) r = gmul(r, 2)
  return r
}

/** Evaluate a polynomial (highest degree first) at x. */
function evalPoly(coefficients: readonly number[], x: number): number {
  let y = 0
  for (const c of coefficients) y = gmul(y, x) ^ c
  return y
}

/** True when the codeword polynomial has every a^i (i < eccLen) as a root. */
function syndromesZero(block: readonly number[], eccLen: number): boolean {
  for (let i = 0; i < eccLen; i++) {
    if (evalPoly(block, alphaPow(i)) !== 0) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// The independent decoder
// ---------------------------------------------------------------------------

function bchRemainder(value: number, generator: number, degree: number, dataBits: number): number {
  let v = value
  for (let i = dataBits - 1; i >= 0; i--) {
    if ((v >>> (i + degree)) & 1) v ^= generator << i
  }
  return v
}

/** Explicit coordinates of format bits 14..0, first copy then second copy. */
function formatCoordinates(size: number): { first: [number, number][]; second: [number, number][] } {
  const first: [number, number][] = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ]
  const second: [number, number][] = []
  // Bits 14..8 run down column 8 from the bottom row.
  for (let bit = 14; bit >= 8; bit--) second.push([size - 1 - (14 - bit), 8])
  // Bits 7..0 run along row 8 from column size-8 to the right edge.
  for (let bit = 7; bit >= 0; bit--) second.push([8, size - 8 + (7 - bit)])
  return { first, second }
}

function readBits(m: QrMatrix, coords: [number, number][]): number {
  let v = 0
  for (const [r, c] of coords) v = (v << 1) | ((m.modules[r] as boolean[])[c] ? 1 : 0)
  return v
}

interface FormatInfo {
  level: number
  mask: number
}

function readFormat(m: QrMatrix): FormatInfo {
  const { first, second } = formatCoordinates(m.size)
  const a = readBits(m, first)
  const b = readBits(m, second)
  expect(b).toBe(a)
  const unmasked = a ^ 0x5412
  expect(bchRemainder(unmasked, 0x537, 10, 5)).toBe(0)
  return { level: unmasked >>> 13, mask: (unmasked >>> 10) & 7 }
}

function readVersion(m: QrMatrix): number {
  const topRight: [number, number][] = []
  const bottomLeft: [number, number][] = []
  for (let bit = 17; bit >= 0; bit--) {
    topRight.push([Math.floor(bit / 3), m.size - 11 + (bit % 3)])
    bottomLeft.push([m.size - 11 + (bit % 3), Math.floor(bit / 3)])
  }
  const a = readBits(m, topRight)
  const b = readBits(m, bottomLeft)
  expect(b).toBe(a)
  expect(bchRemainder(a, 0x1f25, 12, 6)).toBe(0)
  return a >>> 12
}

/** Function-module map from the spec's layout rules, by region. */
function functionMap(version: number): boolean[][] {
  const size = qrSize(version)
  const map = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const mark = (r: number, c: number): void => {
    if (r >= 0 && r < size && c >= 0 && c < size) (map[r] as boolean[])[c] = true
  }
  const rect = (r0: number, c0: number, r1: number, c1: number): void => {
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) mark(r, c)
  }
  // Finders with separators and the format areas beside them.
  rect(0, 0, 8, 8)
  rect(0, size - 8, 8, size - 1)
  rect(size - 8, 0, size - 1, 8)
  // Timing patterns.
  for (let i = 0; i < size; i++) {
    mark(6, i)
    mark(i, 6)
  }
  // Alignment patterns.
  const pos = qrAlignmentPositions(version)
  const last = pos.length - 1
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue
      const r = pos[i] as number
      const c = pos[j] as number
      rect(r - 2, c - 2, r + 2, c + 2)
    }
  }
  // Version information.
  if (version >= 7) {
    rect(0, size - 11, 5, size - 9)
    rect(size - 11, 0, size - 9, 5)
  }
  return map
}

/** Walk the data region in placement order; returns raw (masked) bits. */
function zigzagBits(m: QrMatrix, fn: boolean[][]): number[] {
  const bits: number[] = []
  const size = m.size
  let strip = 0
  let col = size - 1
  while (col > 0) {
    if (col === 6) col = 5
    const upward = strip % 2 === 0
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step
      for (const c of [col, col - 1]) {
        if ((fn[row] as boolean[])[c]) continue
        bits.push((m.modules[row] as boolean[])[c] ? 1 : 0)
      }
    }
    strip++
    col -= 2
  }
  return bits
}

function unmask(m: QrMatrix, fn: boolean[][], mask: number): QrMatrix {
  const modules = m.modules.map((row, r) =>
    row.map((dark, c) => ((fn[r] as boolean[])[c] ? dark : dark !== qrMaskBit(mask, r, c))),
  )
  return { ...m, modules }
}

interface Decoded {
  version: number
  mask: number
  text: string
  /** The data codewords after the payload (terminator + pad bytes). */
  tail: number[]
}

function decode(m: QrMatrix): Decoded {
  const version = (m.size - 17) / 4
  expect(Number.isInteger(version)).toBe(true)
  const fmt = readFormat(m)
  expect(fmt.level).toBe(0) // level M
  if (version >= 7) expect(readVersion(m)).toBe(version)

  const fn = functionMap(version)
  const clean = unmask(m, fn, fmt.mask)
  const bits = zigzagBits(clean, fn)
  const total = qrTotalCodewords(version)
  expect(bits.length).toBe(total * 8 + (REMAINDER_BITS[version - 1] as number))
  const codewords: number[] = []
  for (let i = 0; i < total; i++) {
    let b = 0
    for (let j = 0; j < 8; j++) b = (b << 1) | (bits[i * 8 + j] as number)
    codewords.push(b)
  }

  // De-interleave into blocks.
  const numBlocks = qrBlockCount(version)
  const eccLen = qrEccPerBlock(version)
  const numShort = numBlocks - (total % numBlocks)
  const shortData = Math.floor(total / numBlocks) - eccLen
  const data: number[][] = Array.from({ length: numBlocks }, () => [])
  const ecc: number[][] = Array.from({ length: numBlocks }, () => [])
  let idx = 0
  for (let i = 0; i < shortData + 1; i++) {
    for (let b = 0; b < numBlocks; b++) {
      if (i < shortData || b >= numShort) (data[b] as number[]).push(codewords[idx++] as number)
    }
  }
  for (let i = 0; i < eccLen; i++) {
    for (let b = 0; b < numBlocks; b++) (ecc[b] as number[]).push(codewords[idx++] as number)
  }
  expect(idx).toBe(total)
  for (let b = 0; b < numBlocks; b++) {
    expect(syndromesZero([...(data[b] as number[]), ...(ecc[b] as number[])], eccLen)).toBe(true)
  }

  // Parse the byte-mode segment.
  const dataCw = data.flat()
  const dbits: number[] = []
  for (const cw of dataCw) for (let j = 7; j >= 0; j--) dbits.push((cw >>> j) & 1)
  let p = 0
  const take = (n: number): number => {
    let v = 0
    for (let i = 0; i < n; i++) v = (v << 1) | (dbits[p++] as number)
    return v
  }
  expect(take(4)).toBe(0b0100)
  const count = take(version <= 9 ? 8 : 16)
  const bytes = new Uint8Array(count)
  for (let i = 0; i < count; i++) bytes[i] = take(8)
  // Terminator (up to 4 zeros, fewer only at the very end), then byte
  // alignment with zeros, then alternating pad codewords.
  const term = Math.min(4, dbits.length - p)
  expect(take(term)).toBe(0)
  while (p % 8 !== 0) expect(take(1)).toBe(0)
  const tail: number[] = []
  while (p < dbits.length) tail.push(take(8))
  return { version, mask: fmt.mask, text: new TextDecoder().decode(bytes), tail }
}

function expectFinder(m: QrMatrix, r0: number, c0: number): void {
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3))
      expect((m.modules[r0 + r] as boolean[])[c0 + c]).toBe(ring !== 2)
    }
  }
}

function expectStructure(m: QrMatrix): void {
  const size = m.size
  expectFinder(m, 0, 0)
  expectFinder(m, 0, size - 7)
  expectFinder(m, size - 7, 0)
  // Separators are light.
  for (let i = 0; i < 8; i++) {
    expect((m.modules[7] as boolean[])[i]).toBe(false)
    expect((m.modules[i] as boolean[])[7]).toBe(false)
    expect((m.modules[7] as boolean[])[size - 1 - i]).toBe(false)
    expect((m.modules[i] as boolean[])[size - 8]).toBe(false)
    expect((m.modules[size - 8] as boolean[])[i]).toBe(false)
    expect((m.modules[size - 1 - i] as boolean[])[7]).toBe(false)
  }
  // Timing patterns alternate starting dark, between the finders.
  for (let i = 8; i < size - 8; i++) {
    expect((m.modules[6] as boolean[])[i]).toBe(i % 2 === 0)
    expect((m.modules[i] as boolean[])[6]).toBe(i % 2 === 0)
  }
  // The always-dark module.
  expect((m.modules[size - 8] as boolean[])[8]).toBe(true)
  // Alignment patterns: dark ring, light ring, dark centre.
  const pos = qrAlignmentPositions(m.version)
  const last = pos.length - 1
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc))
          expect((m.modules[(pos[i] as number) + dr] as boolean[])[(pos[j] as number) + dc]).toBe(
            ring !== 1,
          )
        }
      }
    }
  }
}

function roundTrip(text: string): Decoded {
  const m = encodeQr(text)
  expect(m.size).toBe(qrSize(m.version))
  expect(m.modules).toHaveLength(m.size)
  for (const row of m.modules) expect(row).toHaveLength(m.size)
  expectStructure(m)
  const d = decode(m)
  expect(d.text).toBe(text)
  expect(d.version).toBe(m.version)
  expect(d.mask).toBe(m.mask)
  // Pad codewords alternate EC 11 EC 11.
  d.tail.forEach((b, i) => expect(b).toBe(i % 2 === 0 ? 0xec : 0x11))
  return d
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Reed-Solomon known-answer vectors', () => {
  it('reproduces the ISO 18004 Annex I example (01234567, version 1-M)', () => {
    const data = [
      0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec,
      0x11,
    ]
    expect(rsEncode(data, 10)).toEqual([
      0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55,
    ])
  })

  it('reproduces the HELLO WORLD 1-M example', () => {
    const data = [
      0x20, 0x5b, 0x0b, 0x78, 0xd1, 0x72, 0xdc, 0x4d, 0x43, 0x40, 0xec, 0x11, 0xec, 0x11, 0xec,
      0x11,
    ]
    expect(rsEncode(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23])
  })

  it('the independent syndrome check agrees with both vectors', () => {
    const a = [
      0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec,
      0x11, 0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55,
    ]
    expect(syndromesZero(a, 10)).toBe(true)
    // One flipped bit breaks it (so the check is not vacuous).
    const broken = [...a]
    broken[3] = (broken[3] as number) ^ 0x40
    expect(syndromesZero(broken, 10)).toBe(false)
  })
})

describe('format and version information', () => {
  it('matches the published level-M format strings for all eight masks', () => {
    for (let mask = 0; mask < 8; mask++) {
      expect(qrFormatBits(mask).toString(2).padStart(15, '0')).toBe(FORMAT_M[mask])
    }
  })

  it('version information is a valid BCH(18,6) word carrying the version', () => {
    for (let v = 7; v <= QR_MAX_VERSION; v++) {
      const bits = qrVersionBits(v)
      expect(bits >>> 12).toBe(v)
      expect(bchRemainder(bits, 0x1f25, 12, 6)).toBe(0)
    }
    // A published one: version 7 is 000111110010010100.
    expect(qrVersionBits(7).toString(2).padStart(18, '0')).toBe('000111110010010100')
  })
})

describe('version tables against the symbol geometry', () => {
  it('raw data modules / 8 equals the published total codewords, with the published remainder', () => {
    for (let v = 1; v <= QR_MAX_VERSION; v++) {
      expect(qrTotalCodewords(v)).toBe(TOTAL_CODEWORDS[v - 1])
      expect(qrRawDataModules(v) - qrTotalCodewords(v) * 8).toBe(REMAINDER_BITS[v - 1])
    }
  })

  it('byte capacity at level M equals the published table', () => {
    for (let v = 1; v <= QR_MAX_VERSION; v++) {
      expect(qrByteCapacity(v)).toBe(BYTE_CAPACITY_M[v - 1])
    }
  })

  it('the alignment table agrees with the spacing rule', () => {
    expect(qrAlignmentPositions(1)).toEqual([])
    for (let v = 2; v <= QR_MAX_VERSION; v++) {
      const size = qrSize(v)
      const n = Math.floor(v / 7) + 2
      const step = Math.ceil((size - 13) / (n * 2 - 2)) * 2
      const expected: number[] = [6]
      for (let i = n - 2; i >= 0; i--) expected.push(size - 7 - i * step)
      expect([...qrAlignmentPositions(v)]).toEqual(expected)
    }
  })

  it('the function-module map leaves exactly the raw data modules free', () => {
    for (let v = 1; v <= QR_MAX_VERSION; v++) {
      const fn = functionMap(v)
      let free = 0
      for (const row of fn) for (const f of row) if (!f) free++
      expect(free).toBe(qrRawDataModules(v))
    }
  })
})

describe('encode and read back', () => {
  it('a short string lands in version 1 and decodes', () => {
    const d = roundTrip('DH')
    expect(d.version).toBe(1)
  })

  it('fills version 1 exactly, then spills into version 2', () => {
    expect(roundTrip('ABCDEFGHIJKLMN').version).toBe(1)
    expect(roundTrip('ABCDEFGHIJKLMNO').version).toBe(2)
  })

  it('a realistic join link decodes byte for byte', () => {
    const link =
      'https://damicohealth.com/clinic/#join=eyJ2IjoxLCJ1cmwiOiJodHRwczovL3Nzempib3N4ZW5peXFwbmV3enFxLnN1cGFiYXNlLmNvIiwia2V5Ijoic2JfcHVibGlzaGFibGVfYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDUiLCJvcmdOYW1lIjoiS2FiYWxlIENvbW11bml0eSBDbGluaWMifQ'
    const d = roundTrip(link)
    expect(d.version).toBeGreaterThanOrEqual(10)
  })

  it('multi-byte UTF-8 survives (accented, Amharic)', () => {
    roundTrip('Ólafur Þór - ሰላም')
  })

  it('covers the 8-bit and 16-bit count fields and the version-information range', () => {
    const fill = (n: number): string =>
      Array.from({ length: n }, (_, i) => String.fromCharCode(33 + (i % 90))).join('')
    expect(roundTrip(fill(100)).version).toBe(6) // 106 fits, 84 does not
    expect(roundTrip(fill(122)).version).toBe(7) // first version with version information
    expect(roundTrip(fill(150)).version).toBe(8) // two block sizes
    expect(roundTrip(fill(200)).version).toBe(10) // 16-bit count field
    expect(roundTrip(fill(300)).version).toBe(13)
    expect(roundTrip(fill(450)).version).toBe(16) // exact capacity
    expect(roundTrip(fill(666)).version).toBe(20) // the ceiling, exact
  })

  it('refuses text past version 20 with the exact message', () => {
    expect(() => encodeQr('x'.repeat(667))).toThrow(QR_TOO_LONG_ERROR)
  })

  it('is deterministic', () => {
    const a = encodeQr('https://damicohealth.com/clinic/#join=abc')
    const b = encodeQr('https://damicohealth.com/clinic/#join=abc')
    expect(a).toEqual(b)
  })

  it('exercises more than one mask across a corpus (the selection is real)', () => {
    const masks = new Set<number>()
    for (let i = 0; i < 40; i++) masks.add(roundTrip(`join-${i}-${'ab'.repeat(i)}`).mask)
    expect(masks.size).toBeGreaterThan(1)
  })
})

describe('qrSvgPath', () => {
  it('draws every dark module once with a 4-module quiet zone', () => {
    const m = encodeQr('https://damicohealth.com/clinic/')
    const { d, viewSize } = qrSvgPath(m)
    expect(viewSize).toBe(m.size + 8)
    // Rebuild the matrix from the path and compare.
    const rebuilt = Array.from({ length: m.size }, () => new Array<boolean>(m.size).fill(false))
    const re = /M(\d+),(\d+)h(\d+)v1h-(\d+)z/g
    let match: RegExpExecArray | null
    let runs = 0
    while ((match = re.exec(d)) !== null) {
      runs++
      const x = Number(match[1]) - 4
      const y = Number(match[2]) - 4
      const w = Number(match[3])
      expect(Number(match[4])).toBe(w)
      for (let i = 0; i < w; i++) {
        expect((rebuilt[y] as boolean[])[x + i]).toBe(false)
        ;(rebuilt[y] as boolean[])[x + i] = true
      }
    }
    expect(runs).toBeGreaterThan(0)
    expect(d.length).toBe(d.replace(/[^Mhvz\d,.-]/g, '').length)
    expect(rebuilt).toEqual(m.modules)
  })
})
