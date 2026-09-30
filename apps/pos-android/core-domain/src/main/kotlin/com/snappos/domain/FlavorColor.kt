package com.snappos.domain

import kotlin.math.absoluteValue

/**
 * A stable hue, 0..359, for a name that has no photograph.
 *
 * Lives in the domain rather than next to the composable that draws it
 * because the back office runs the identical function: somebody who set up
 * "Honey Berry" at the desk should see the same colour again on the till, and
 * that only holds if both sides agree exactly. `hueFor` in the dashboard's
 * `FlavorTile.tsx` is this function in TypeScript, and `FlavorColorTest` pins
 * the values both must produce.
 *
 * FNV-1a rather than a sum of character codes, which would give "Blue Razz"
 * and "Razz Blue" -- two different flavours -- the same colour.
 *
 * The arithmetic is 32-bit wrapping on both sides: Kotlin's `Int` overflows
 * the way JavaScript's `Math.imul` does. The modulo goes through `Long`
 * because `Int.MIN_VALUE`'s absolute value does not fit in an `Int` and would
 * otherwise come back negative.
 */
fun hueFor(name: String): Int {
  var hash = -0x7ee3623b // 0x811c9dc5
  for (character in name) {
    hash = hash xor character.code
    hash *= 0x01000193
  }
  return (hash.toLong().absoluteValue % 360L).toInt()
}
