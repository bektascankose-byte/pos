package com.snappos.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.Callable
import java.util.concurrent.Executors

/**
 * Mirrors the server's invariant test "uuid_generate_v7 emits valid v7 values,
 * monotonic within a millisecond" in `packages/db/test/invariants.test.mjs`.
 *
 * Both sides mint these ids and both have to behave the same way, because a
 * sale's id is minted on the register and accepted by the server as given.
 */
class Uuid7Test {

  private val UUID_SHAPE = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

  @Test
  fun `emits well formed v7 values`() {
    repeat(1000) {
      val id = Uuid7.generate()
      assertTrue("malformed: $id", UUID_SHAPE.matches(id))
      assertTrue("not version 7: $id", Uuid7.isV7(id))

      // Variant bits must be 10xx, so the first character of the fourth group
      // is one of 8, 9, a or b.
      val variantNibble = id.substring(19, 20)
      assertTrue("bad variant in $id", variantNibble in listOf("8", "9", "a", "b"))
    }
  }

  @Test
  fun `ids are monotonic within a single millisecond`() {
    // Android's clock has millisecond resolution and a cashier scanning a fast
    // sequence mints several ids inside one tick. Without the counter those ids
    // are unordered, which throws away the index locality that motivated v7
    // over v4 and makes the order lines were rung unrecoverable.
    val ids = List(5000) { Uuid7.generate() }
    assertEquals("duplicates emitted", ids.size, ids.toSet().size)

    val sorted = ids.sorted()
    assertEquals("ids do not sort in generation order", ids, sorted)
  }

  @Test
  fun `the embedded timestamp is recoverable and close to now`() {
    // The server derives a ledger entry's occurred_at from this, so the id and
    // its timestamp cannot disagree. inventory_ledger is partitioned by month
    // and keyed on (id, occurred_at): an id replayed with a different timestamp
    // would not conflict and would deduct stock twice while appearing safe.
    val before = System.currentTimeMillis()
    val id = Uuid7.generate()
    val after = System.currentTimeMillis()

    val embedded = Uuid7.timestampOf(id)
    assertTrue("$embedded is not within [$before, $after]", embedded in before..after)
  }

  @Test
  fun `concurrent generation produces no duplicates`() {
    // Two coroutines can touch the cart during a fast scan sequence, so the
    // counter has to be safe under contention, not merely correct on one thread.
    val pool = Executors.newFixedThreadPool(8)
    try {
      val tasks = List(8) { Callable { List(2000) { Uuid7.generate() } } }
      val all = pool.invokeAll(tasks).flatMap { it.get() }
      assertEquals("duplicates under concurrency", all.size, all.toSet().size)
    } finally {
      pool.shutdown()
    }
  }

  @Test
  fun `a v4 uuid is recognised as not v7`() {
    // The server refuses a v4 where a v7 is required, because a v4 there means
    // something generated the id with the wrong function.
    assertTrue(!Uuid7.isV7("9f1b4c2e-5a3d-4b6e-8c7f-1234567890ab"))
    assertNotEquals(Uuid7.generate(), Uuid7.generate())
  }
}
