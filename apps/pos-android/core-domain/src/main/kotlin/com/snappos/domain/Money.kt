package com.snappos.domain

import java.math.BigInteger

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
    val value = BigInteger.valueOf(minor)
    val negative = value.signum() < 0
    val absolute = value.abs()
    val whole = absolute.divide(HUNDRED)
    val frac = absolute.remainder(HUNDRED).toInt()
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
      val cents = BigInteger(whole)
        .multiply(HUNDRED)
        .add(BigInteger(frac.padEnd(2, '0').ifEmpty { "0" }))
      return Money((if (sign == "-") cents.negate() else cents).longValueExact())
    }

    fun sum(values: Iterable<Money>): Money = values.fold(ZERO) { acc, v -> acc + v }
  }
}

class MoneyFormatException(message: String) : IllegalArgumentException(message)

private val RATE = Regex("""^(-?)(\d+)(?:\.(\d+))?$""")
private val COST = Regex("""^(-?)(\d+)(?:\.(\d{1,6}))?$""")
private val TEN = BigInteger.TEN
private val HUNDRED = BigInteger.valueOf(100)

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

  val scale = TEN.pow(frac.length)
  val scaledRate = BigInteger(whole)
    .multiply(scale)
    .add(BigInteger(frac.ifEmpty { "0" }))
    .let { if (sign == "-") it.negate() else it }

  val rounded = divideRoundHalfUp(BigInteger.valueOf(minor).multiply(scaledRate), scale)
  return Money(rounded.longValueExact())
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

  val amountValue = BigInteger.valueOf(minor)
  val totalValue = BigInteger.valueOf(total.minor)
  val shares = weights.map {
    amountValue.multiply(BigInteger.valueOf(it.minor)).divide(totalValue).longValueExact()
  }.toMutableList()
  val remainder = Math.subtractExact(minor, shares.fold(0L, Math::addExact))

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
internal fun divideRoundHalfUp(numerator: BigInteger, denominator: BigInteger): BigInteger {
  require(denominator.signum() != 0) { "denominator must not be zero" }
  val negative = numerator.signum() != denominator.signum()
  val n = numerator.abs()
  val d = denominator.abs()
  val quotient = n.divide(d)
  val doubled = n.remainder(d).multiply(BigInteger.TWO)
  val rounded = if (doubled >= d) quotient + BigInteger.ONE else quotient
  return if (negative) rounded.negate() else rounded
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
  val match = COST.matchEntire(cost.trim())
    ?: throw MoneyFormatException("\"$cost\" is not a valid cost (max six decimal places)")
  val (sign, whole, frac) = match.destructured

  val scale = TEN.pow(frac.length)
  val scaled = BigInteger(whole)
    .multiply(scale)
    .add(BigInteger(frac.ifEmpty { "0" }))
  val numerator = scaled.multiply(HUNDRED).multiply(BigInteger.valueOf(quantity.toLong()))
  val minor = divideRoundHalfUp(numerator, scale).let {
    if (sign == "-") it.negate() else it
  }
  return Money(minor.longValueExact())
}
