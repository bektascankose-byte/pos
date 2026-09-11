package com.snappos.domain

import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicLong

/**
 * UUIDv7, generated on device.
 *
 * The register mints these before it has ever seen a network, and the server
 * accepts them as given. That is what makes the offline guarantee work: the id
 * of a sale is fixed at the moment the cashier takes payment, so a replayed
 * upload collides on the primary key instead of creating a second sale.
 *
 * The layout, per RFC 9562:
 *
 *     48 bits  unix milliseconds, big endian
 *      4 bits  version (7)
 *     12 bits  rand_a — used here as a monotonic counter
 *      2 bits  variant (10)
 *     62 bits  random
 *
 * **Monotonicity within a millisecond is not optional here.** Android's clock
 * has millisecond resolution, and a cashier scanning a rapid sequence produces
 * several ids inside one tick. Without the counter those ids are unordered,
 * which throws away the index locality that motivated v7 over v4 in the first
 * place, and makes "the order lines were rung" unrecoverable from the ids.
 *
 * The 12 bit counter gives 4096 ids per millisecond before it rolls into the
 * next millisecond, which is four orders of magnitude more than a counter can
 * produce.
 *
 * This mirrors `uuid_generate_v7()` in `packages/db/migrations/0001_foundation.sql`
 * deliberately. Both sides step the counter the same way on a clock that does
 * not advance or moves backwards, so an id minted on a register and one minted
 * on the server are the same kind of value.
 */
object Uuid7 {

  private val random = SecureRandom()

  /** Packs the last millisecond and counter into one Long for a lock-free CAS. */
  private val state = AtomicLong(0)

  private const val COUNTER_BITS = 12
  private const val MAX_COUNTER = (1 shl COUNTER_BITS) - 1

  fun generate(): String {
    val bytes = ByteArray(16)
    random.nextBytes(bytes)

    var millis: Long
    var counter: Int

    while (true) {
      val now = System.currentTimeMillis()
      val previous = state.get()
      val previousMillis = previous ushr COUNTER_BITS
      val previousCounter = (previous and MAX_COUNTER.toLong()).toInt()

      if (now > previousMillis) {
        millis = now
        counter = 0
      } else {
        // The clock did not advance, or went backwards across an NTP
        // correction. Step the counter rather than emitting a duplicate or a
        // value that sorts before one already issued.
        millis = previousMillis
        counter = previousCounter + 1
        if (counter > MAX_COUNTER) {
          millis = previousMillis + 1
          counter = 0
        }
      }

      if (state.compareAndSet(previous, (millis shl COUNTER_BITS) or counter.toLong())) break
    }

    // 48 bit timestamp
    bytes[0] = (millis ushr 40).toByte()
    bytes[1] = (millis ushr 32).toByte()
    bytes[2] = (millis ushr 24).toByte()
    bytes[3] = (millis ushr 16).toByte()
    bytes[4] = (millis ushr 8).toByte()
    bytes[5] = millis.toByte()

    // version 7 in the high nibble, counter high bits in the low nibble
    bytes[6] = (0x70 or (counter ushr 8)).toByte()
    bytes[7] = (counter and 0xFF).toByte()

    // variant 10
    bytes[8] = ((bytes[8].toInt() and 0x3F) or 0x80).toByte()

    return format(bytes)
  }

  /**
   * The millisecond a v7 id encodes.
   *
   * The server derives an inventory ledger entry's `occurred_at` from this, so
   * the id and its timestamp cannot disagree. That matters more than it looks:
   * `inventory_ledger` is partitioned by month and keyed on
   * `(id, occurred_at)`, so an id replayed with a different timestamp would not
   * conflict, and would deduct stock twice while appearing to be protected.
   */
  fun timestampOf(uuid: String): Long {
    val hex = uuid.replace("-", "")
    require(hex.length == 32) { "\"$uuid\" is not a UUID" }
    return hex.substring(0, 12).toLong(16)
  }

  fun isV7(uuid: String): Boolean {
    val hex = uuid.replace("-", "")
    return hex.length == 32 && hex[12] == '7'
  }

  private fun format(bytes: ByteArray): String {
    val hex = CharArray(32)
    val digits = "0123456789abcdef"
    for (i in bytes.indices) {
      val value = bytes[i].toInt() and 0xFF
      hex[i * 2] = digits[value ushr 4]
      hex[i * 2 + 1] = digits[value and 0x0F]
    }
    return buildString(36) {
      append(hex, 0, 8)
      append('-')
      append(hex, 8, 4)
      append('-')
      append(hex, 12, 4)
      append('-')
      append(hex, 16, 4)
      append('-')
      append(hex, 20, 12)
    }
  }
}
