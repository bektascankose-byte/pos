package com.snappos.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The colour a flavour gets when nobody has photographed it.
 *
 * Same argument as `MoneyTest`: two implementations of one rule drift, and
 * here the rule is a hash the dashboard also computes. Every number below was
 * produced by running the dashboard's `hueFor` in Node against that exact
 * string, so changing one side without the other fails here rather than
 * quietly giving one flavour two colours -- the till's and the back office's
 * -- which nobody would notice until they saw them side by side.
 */
class FlavorColorTest {
  @Test
  fun `matches the dashboard implementation`() {
    assertEquals(220, hueFor("Honey Berry"))
    assertEquals(81, hueFor("Rum"))
    assertEquals(326, hueFor("Original"))
    assertEquals(188, hueFor("Russian Cream"))
    assertEquals(103, hueFor("Sweet Aromatic"))
    assertEquals(12, hueFor("Mexican Mango"))
    // The case that caught a real disagreement: the loop never runs, so this
    // is the bare seed. JavaScript left it a double until the first bitwise
    // op, which for an empty name never happened -- see `hueFor` in the
    // dashboard, which now coerces the seed up front.
    assertEquals(195, hueFor(""))
    assertEquals(244, hueFor("A"))
  }

  /** The whole reason for a real hash: reordered words are a different flavour. */
  @Test
  fun `word order changes the colour`() {
    assertEquals(34, hueFor("Blue Razz"))
    assertEquals(124, hueFor("Razz Blue"))
  }

  @Test
  fun `is always a usable hue`() {
    val names = listOf(
      "", "A", "Honey Berry", "Rum", "a very long flavour name that goes on and on",
      "Ünïcödé Flavour", "123", "   ", "Blue Razz Ice", "Mango",
    )
    for (name in names) {
      val hue = hueFor(name)
      assertTrue("$name gave $hue", hue in 0..359)
    }
  }

  @Test
  fun `is stable across calls`() {
    assertEquals(hueFor("Honey Berry"), hueFor("Honey Berry"))
  }
}
