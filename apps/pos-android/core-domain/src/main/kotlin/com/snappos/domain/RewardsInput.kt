package com.snappos.domain

/**
 * What a customer types on their own screen, checked before it is sent.
 *
 * The server checks all of this again and is the authority. These exist so
 * the screen can say "that is not a phone number" the moment the customer
 * finishes typing, instead of making them wait on a round trip to be told
 * something a keypad already knows.
 *
 * Mirrors `normalizeUsPhone` and `isRealBirthday` in the contracts package.
 * Kept in step by the tests on both sides using the same cases.
 */
object RewardsInput {

  /**
   * E.164 for ten typed digits, or null when they are not a real number.
   *
   * North American numbers only, like the server. An area code or an exchange
   * never starts with 0 or 1, which catches most slips of the finger
   * (a missed first digit, a number started with 1) without a lookup.
   */
  fun phoneToE164(digits: String): String? {
    if (digits.length != 10 || !digits.all { it in '0'..'9' }) return null
    if (digits[0] !in '2'..'9' || digits[3] !in '2'..'9') return null
    return "+1$digits"
  }

  /** "(254) 555-0137" for a US E.164 number, anything else unchanged. */
  fun formatPhone(e164: String): String {
    val digits = e164.removePrefix("+1")
    if (!e164.startsWith("+1") || digits.length != 10 || !digits.all { it in '0'..'9' }) return e164
    return "(${digits.take(3)}) ${digits.drop(3).take(3)}-${digits.drop(6)}"
  }

  /**
   * Whether text is shaped like an email address.
   *
   * Deliberately loose. The only way to know an address is real is to send
   * to it, so this refuses what cannot be one (no @, two of them, nothing
   * before it, no dot after it, a space) and lets the rest through.
   */
  fun isEmail(text: String): Boolean {
    if (text.length !in 6..254 || text.any { it.isWhitespace() }) return false
    val at = text.indexOf('@')
    if (at < 1 || at != text.lastIndexOf('@')) return false
    val domain = text.substring(at + 1)
    val dot = domain.lastIndexOf('.')
    if (dot < 1 || domain.length - dot - 1 < 2) return false
    return !domain.startsWith('.') && !domain.contains("..") && !text.startsWith('.')
  }

  /**
   * How long each month can be. February is 29: a birthday carries no year
   * here, so a leap day is a real birthday and has to be enterable.
   */
  fun daysInMonth(month: Int): Int = when (month) {
    2 -> 29
    4, 6, 9, 11 -> 30
    in 1..12 -> 31
    else -> 0
  }

  fun isBirthday(month: Int, day: Int): Boolean = day in 1..daysInMonth(month)
}
