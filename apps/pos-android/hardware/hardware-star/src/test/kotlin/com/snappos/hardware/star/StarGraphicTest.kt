package com.snappos.hardware.star

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class StarGraphicTest {

  private fun hex(vararg b: Int) = ByteArray(b.size) { b[it].toByte() }

  private val enter = hex(0x1B, '*'.code, 'r'.code, 'A'.code)
  private val continuous = hex(0x1B, '*'.code, 'r'.code, 'P'.code, '0'.code, 0)
  private val leave = hex(0x1B, '*'.code, 'r'.code, 'B'.code)

  @Test
  fun `a job is enter, continuous, rows, leave`() {
    val job = StarGraphic.job(listOf(hex(0xFF, 0x0F)))
    assertArrayEquals(enter + continuous + hex('b'.code, 2, 0, 0xFF, 0x0F) + leave, job)
  }

  @Test
  fun `trailing white is trimmed from a row`() {
    val row = ByteArray(72).also { it[0] = 0x80.toByte(); it[5] = 0x01 }
    val job = StarGraphic.job(listOf(row))
    val body = job.copyOfRange(enter.size + continuous.size, job.size - leave.size)
    assertArrayEquals(hex('b'.code, 6, 0, 0x80, 0, 0, 0, 0, 0x01), body)
  }

  @Test
  fun `an all white row still feeds one line`() {
    val job = StarGraphic.job(listOf(ByteArray(72)))
    val body = job.copyOfRange(enter.size + continuous.size, job.size - leave.size)
    assertArrayEquals(hex('b'.code, 1, 0, 0), body)
  }

  @Test
  fun `no cut asks for feed only`() {
    val job = StarGraphic.job(emptyList(), cut = false)
    assertArrayEquals(enter + continuous + hex(0x1B, '*'.code, 'r'.code, 'E'.code, '1'.code, 0) + leave, job)
  }

  @Test(expected = IllegalArgumentException::class)
  fun `a row wider than the head is refused`() {
    StarGraphic.job(listOf(ByteArray(73)))
  }

  @Test
  fun `the drawer is BEL`() {
    assertArrayEquals(hex(0x07), StarGraphic.OPEN_DRAWER)
  }

  // ------------------------------------------------------------------ pack

  @Test
  fun `leftmost dot is the high bit`() {
    val rows = StarGraphic.pack(16, 1) { x, _ -> x == 0 || x == 9 }
    assertArrayEquals(hex(0x80, 0x40), rows.single())
  }

  @Test
  fun `a width that is not a multiple of eight rounds up`() {
    val rows = StarGraphic.pack(10, 2) { _, y -> y == 1 }
    assertEquals(2, rows[0].size)
    assertArrayEquals(hex(0, 0), rows[0])
    assertArrayEquals(hex(0xFF, 0xC0), rows[1])
  }

  @Test
  fun `a picture wider than the head is clipped, not refused`() {
    val rows = StarGraphic.pack(1000, 1) { _, _ -> true }
    assertEquals(72, rows.single().size)
    assertEquals(0xFF.toByte(), rows.single().last())
  }
}
