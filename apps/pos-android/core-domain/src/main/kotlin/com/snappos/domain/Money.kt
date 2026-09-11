package com.snappos.domain

/**
 * Money, in minor units.
 *
 * This is the Kotlin half of a type that exists twice, and the two halves must
 * agree to the cent. The register computes a total offline; the server later
 * recomputes it. If they disagree, the customer was charged something the
 * reports do not recognise, and nobody finds out until a reconciliation months
 * later.
 *
 * Every decision here mirrors `packages/contracts/src/money.ts` deliberately:
 *
 *   - `Long` minor units, never `Double`. IEEE-754 cannot represent 0.1, and a
 *     cart that sums floats drifts by a cent often enough to matter and rarely
 *     enough to be hard to find.
 *   - Rates are decimal strings, scaled to integers before dividing. 0.0825 has
 *     no exact binary form, and tax is the one number nobody forgives.
 *   - Rounding is half up, away from zero, once per line, at post time. Banker's
 *     rounding is defensible in accounting and wrong at a counter: two identical
 *     receipts must not show two different totals.
 *
 * A value class, so it costs nothing at runtime and still cannot be added to a
 * plain number by accident.
 */
@JvmInline
value class Money(val minor: Long) : Comparable<Money> {

  operator fun plus(other: Money) = Money(Math.addExact(minor, other.minor))
  operator fun minus(other: Money) = Money(Math.subtractExact(minor, other.minor))
  operator fun unaryMinus() = Money(Math.negateExact(minor))

  /** Whole unit multiply: 3 x $24.99. Exact; no rounding involved. */
  operator fun times(quantity: Int) = Money(Math.multiplyExact(minor, quantity.toLong()))

  override fun compareTo(other: Money): Int = minor.compareTo(other.minor)

  val isZero: Boolean get() = minor == 0L
  val isNegative: Boolean get() = minor < 0L

  /** Display only. Never parse this back for arithmetic. */
  fun toMajorString(): String {
    val negative = minor < 0
    val abs = if (negative) -minor else minor
    val whole = abs / 100
    val frac = abs % 100
    return buildString {
      if (negative) append('-')
      append(whole)
      append('.')
      if (frac < 10) append('0')
      append(frac)
    }
  }

  /**
   * On the wire, always a digit string.
   *
   * JSON has no 64 bit integer that survives a JavaScript client, so a number
   * would be silently lossy above 2^53 and would invite float arithmetic on a
   * value that must stay exact.
   */
  fun serialize(): String = minor.toString()

  override fun toString(): String = toMajorString()

  companion object {
    val ZERO = Money(0)

    fun ofMinor(minor: Long) = Money(minor)

    fun deserialize(value: String): Money =
      Money(
        value.trim().toLongOrNull()
          ?: throw MoneyFormatException("\"$value\" is not whole minor units"),
      )

    private val MAJOR = Regex("""^(-?)(\d+)(?:\.(\d{1,2}))?$""")

    /**
     * Parse a major-unit amount: "24.99", "24.9", "24", "-3.50".
     *
     * More precision than a cent is refused rather than truncated, because
     * "24.999" almost always means a cost was passed where a price was wanted.
     */
    fun fromMajor(text: String): Money {
      val match = MAJOR.matchEntire(text.trim())
        ?: throw MoneyFormatException("\"$text\" is not a valid amount with at most two decimals")
      val (sign, whole, frac) = match.destructured
      val cents = whole.toLong() * 100 + frac.padEnd(2, '0').ifEmpty { "0" }.toLong()
      return Money(if (sign == "-") -cents else cents)
    }

    fun sum(values: Iterable<Money>): Money = values.fold(ZERO) { acc, v -> acc + v }
  }
}

class MoneyFormatException(message: String) : IllegalArgumentException(message)

private val RATE = Regex("""^(-?)(\d+)(?:\.(\d+))?$""")

/**
 * Apply a rate (tax, percentage discount) and round half up.
 *
 * The rate stays a string right up to the division. Parsing "0.0825" into a
 * Double first would reintroduce exactly the error this whole file exists to
 * avoid.
 */
fun Money.applyRate(rate: String): Money {
  val match = RATE.matchEntire(rate.trim())
    ?: throw MoneyFormatException("\"$rate\" is not a valid rate")
  val (sign, whole, frac) = match.destructured

  var scale = 1L
  repeat(frac.length) { scale *= 10 }

  val scaledRate = (whole.toLong() * scale + (frac.ifEmpty { "0" }).toLong()) *
    (if (sign == "-") -1 else 1)

  return Money(divideRoundHalfUp(Math.multiplyExact(minor, scaledRate), scale))
}

/**
 * Split into n parts that sum back to exactly the original.
 *
 * $10.00 three ways is 334, 333, 333 — not three times 333 with a cent
 * evaporating. Split tender and proportional discount allocation both depend on
 * this, and a naive divide gets both wrong in the customer's favour or the
 * shop's, unpredictably.
 */
fun Money.allocate(parts: Int): List<Money> {
  require(parts >= 1) { "cannot allocate across $parts parts" }

  val base = minor / parts
  val remainder = minor - base * parts
  val step = if (remainder < 0) -1L else 1L
  var left = if (remainder < 0) -remainder else remainder

  return List(parts) {
    val extra = if (left > 0) step else 0L
    if (left > 0) left--
    Money(base + extra)
  }
}

/**
 * Allocate proportionally to weights, remainder to the largest weights first.
 *
 * Spreads a cart level discount across lines so the line amounts still sum to
 * the cart total.
 */
fun Money.allocateByWeight(weights: List<Money>): List<Money> {
  val total = Money.sum(weights)
  if (total.isZero) return allocate(weights.size)

  val shares = weights.map { minor * it.minor / total.minor }.toMutableList()
  val remainder = minor - shares.sum()

  val order = weights.withIndex().sortedByDescending { it.value.minor }.map { it.index }
  val step = if (remainder < 0) -1L else 1L
  var left = if (remainder < 0) -remainder else remainder

  for (index in order) {
    if (left == 0L) break
    shares[index] = shares[index] + step
    left--
  }
  return shares.map { Money(it) }
}

/** Integer division rounding half away from zero. */
internal fun divideRoundHalfUp(numerator: Long, denominator: Long): Long {
  val negative = (numerator < 0) != (denominator < 0)
  val n = if (numerator < 0) -numerator else numerator
  val d = if (denominator < 0) -denominator else denominator
  val quotient = n / d
  val doubled = (n % d) * 2
  val rounded = if (doubled >= d) quotient + 1 else quotient
  return if (negative) -rounded else rounded
}

/**
 * Post a fractional catalog cost to minor units.
 *
 * Cost is `numeric(14,6)` on the server: a case of 12 at $5.00 is $0.416667 a
 * unit, and rounding that to cents corrupts margin reporting within weeks. It
 * stays a string here for the same reason a rate does, and rounds exactly once,
 * at the moment it is posted.
 */
fun costToMinor(cost: String, quantity: Int = 1): Money {
  val match = RATE.matchEntire(cost.trim())
    ?: throw MoneyFormatException("\"$cost\" is not a valid cost")
  val (sign, whole, frac) = match.destructured

  var scale = 1L
  repeat(frac.length) { scale *= 10 }

  val scaled = whole.toLong() * scale + (frac.ifEmpty { "0" }).toLong()
  val minor = divideRoundHalfUp(scaled * 100 * quantity, scale)
  return Money(if (sign == "-") -minor else minor)
}
