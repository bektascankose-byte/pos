package com.snappos.hardware.star

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import com.snappos.domain.Emphasis
import com.snappos.domain.PaperWidth
import com.snappos.domain.ReceiptDocument
import com.snappos.domain.ReceiptElement
import com.snappos.domain.TextReceipt
import kotlin.math.ceil

/**
 * A receipt, drawn as the dots a TSP100 prints.
 *
 * Laid out by `TextReceipt` at 48 columns, the same code that draws the receipt
 * on the till's screen, so the paper and the screen cannot disagree about what
 * goes where. This only decides how each character looks: a monospaced font
 * sized so 48 of them fill the 576-dot head exactly, bold for emphasis, and
 * double height for the total, the way every thermal receipt has always shown
 * it.
 *
 * Each element is laid out on its own so it keeps its own emphasis. Laying out
 * the whole document at once would give the right lines with the styling lost.
 */
internal object ReceiptRaster {

  private val WIDTH = PaperWidth.Mm80

  /** Space above the first line and below the last, in dots. The cutter adds its own below. */
  private const val TOP = 8
  private const val BOTTOM = 16

  /** Anti-aliased grey darker than this becomes a dot. Thermal paper prints thin, so it errs dark. */
  private const val INK = 160

  private data class Line(val text: String, val emphasis: Emphasis)

  fun rows(document: ReceiptDocument): List<ByteArray> {
    val lines = document.elements.flatMap { element ->
      val emphasis = when (element) {
        is ReceiptElement.Text -> element.emphasis
        is ReceiptElement.Row -> element.emphasis
        else -> Emphasis.Normal
      }
      TextReceipt.render(ReceiptDocument(listOf(element)), WIDTH).map { Line(it, emphasis) }
    }

    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      typeface = Typeface.MONOSPACE
      color = Color.BLACK
      textSize = 24f
    }
    // Size the font so one character is exactly a 48th of the head.
    val cell = TSP100_DOTS.toFloat() / WIDTH.columns
    paint.textSize = 24f * cell / paint.measureText("0")
    val metrics = paint.fontMetrics
    val lineHeight = ceil(metrics.descent - metrics.ascent).toInt() + 2

    fun heightOf(line: Line) = if (line.emphasis == Emphasis.Large) lineHeight * 2 else lineHeight
    val height = TOP + lines.sumOf(::heightOf) + BOTTOM

    val bitmap = Bitmap.createBitmap(TSP100_DOTS, height, Bitmap.Config.ARGB_8888)
    try {
      val canvas = Canvas(bitmap)
      canvas.drawColor(Color.WHITE)
      var top = TOP.toFloat()
      for (line in lines) {
        val tall = line.emphasis == Emphasis.Large
        paint.isFakeBoldText = line.emphasis != Emphasis.Normal
        // Double height, same width: the font twice as big, squeezed back to
        // one cell across, so a large line still lines up with the columns.
        val size = paint.textSize
        if (tall) {
          paint.textSize = size * 2
          paint.textScaleX = 0.5f
        }
        canvas.drawText(line.text, 0f, top - paint.fontMetrics.ascent, paint)
        if (tall) {
          paint.textSize = size
          paint.textScaleX = 1f
        }
        top += heightOf(line)
      }

      val pixels = IntArray(TSP100_DOTS * height)
      bitmap.getPixels(pixels, 0, TSP100_DOTS, 0, 0, TSP100_DOTS, height)
      return StarGraphic.pack(TSP100_DOTS, height) { x, y ->
        val p = pixels[y * TSP100_DOTS + x]
        (Color.red(p) + Color.green(p) + Color.blue(p)) / 3 < INK
      }
    } finally {
      bitmap.recycle()
    }
  }
}
