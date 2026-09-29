package com.snappos.hardware.star

import java.io.ByteArrayOutputStream

/**
 * The printable width of an 80mm TSP100 in dots: 72 bytes of eight dots.
 *
 * At the printer's 203 dpi that is 72mm of the 80mm roll, the rest being the
 * margins the head physically cannot reach.
 */
const val TSP100_DOTS = 576

/**
 * Star Graphic mode: the only language a TSP100 speaks.
 *
 * The TSP100 family has no fonts. It is not an ESC/POS printer and it does not
 * understand Star Line mode either; everything it prints, text included,
 * arrives as rows of dots. That is less of a limitation than it sounds, because
 * the receipt is already described rather than formatted (see
 * `ReceiptDocument`), so the driver was always going to decide how it looks.
 *
 * Four commands are all a receipt needs, from Star's Graphic Mode Command
 * Specifications:
 *
 *     ESC * r A          enter raster mode
 *     ESC * r P 0 NUL    continuous paper, no fixed page length
 *     b n1 n2 d1..dk     one row of dots, k = n1 + n2 * 256, then line feed
 *     ESC * r B          leave raster mode, which prints, feeds and cuts
 *
 * plus BEL, which drives the cash drawer wired to the printer and is accepted
 * in and out of raster mode alike.
 *
 * Pure bytes, no Android, so every byte of it is tested on the JVM.
 */
object StarGraphic {

  private const val ESC = 0x1B

  /** Drawer 1, the port on the back of the printer. */
  val OPEN_DRAWER: ByteArray = byteArrayOf(0x07)

  /**
   * One print job: the rows, in order, top to bottom.
   *
   * Trailing blank bytes are trimmed from every row. A receipt is mostly white
   * on the right of every line, and a row that says "print these 20 bytes" is
   * the same row as one that says "these 20 and 52 zeros" at a quarter of the
   * data down the cable. A row is never sent empty, though: an all-white row
   * still has to move the paper.
   *
   * @param cut false leaves the paper uncut, for jobs printed back to back.
   */
  fun job(rows: List<ByteArray>, cut: Boolean = true): ByteArray {
    val out = ByteArrayOutputStream(rows.size * 24 + 32)
    out.write(bytes(ESC, '*', 'r', 'A'))
    out.write(bytes(ESC, '*', 'r', 'P', '0', 0))
    // EOT mode 1 is "feed only". The default, 13, feeds to the cutter and makes
    // a partial cut, which is what a receipt wants.
    if (!cut) out.write(bytes(ESC, '*', 'r', 'E', '1', 0))
    for (row in rows) {
      require(row.size <= TSP100_DOTS / 8) { "A row is at most ${TSP100_DOTS / 8} bytes, not ${row.size}" }
      val used = (row.indexOfLast { it.toInt() != 0 } + 1).coerceAtLeast(1)
      out.write('b'.code)
      out.write(used and 0xFF)
      out.write(used shr 8)
      out.write(row, 0, used)
    }
    out.write(bytes(ESC, '*', 'r', 'B'))
    return out.toByteArray()
  }

  /**
   * Pack a picture into printer rows.
   *
   * Eight dots to a byte, the leftmost in the high bit, a set bit printing
   * black. [width] is clamped to the printer, so a picture that is too wide
   * loses its right edge rather than failing the job.
   */
  fun pack(width: Int, height: Int, isDot: (x: Int, y: Int) -> Boolean): List<ByteArray> {
    val dots = width.coerceAtMost(TSP100_DOTS)
    val bytesPerRow = (dots + 7) / 8
    return List(height) { y ->
      val row = ByteArray(bytesPerRow)
      for (x in 0 until dots) {
        if (isDot(x, y)) {
          val i = x shr 3
          row[i] = (row[i].toInt() or (0x80 ushr (x and 7))).toByte()
        }
      }
      row
    }
  }

  private fun bytes(vararg parts: Any): ByteArray = ByteArray(parts.size) { i ->
    when (val p = parts[i]) {
      is Int -> p.toByte()
      is Char -> p.code.toByte()
      else -> error("not a byte: $p")
    }
  }
}
