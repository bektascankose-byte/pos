package com.snappos.domain

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * The Kotlin half of the conformance suite.
 *
 * The TypeScript half is `packages/pricing-spec/test/conformance.test.mjs` and
 * reads **the same JSON files**. That is the entire point.
 *
 * The money arithmetic exists twice — once on the server in TypeScript, once
 * here on the register — because a register has to price a cart with the
 * network unplugged. Two implementations of the same rules drift, and when they
 * do the symptom is a receipt that disagrees with the books by a cent on some
 * subset of carts, with no way to say which side is right. The architecture
 * calls this the number one technical risk and the fixtures the mitigation that
 * "is not optional".
 *
 * Neither engine is the reference. The JSON is.
 */
class PricingConformanceTest {

  private val json = Json { ignoreUnknownKeys = true }

  /**
   * Find `packages/pricing-spec/fixtures` by walking up from wherever the test
   * happens to be run.
   *
   * Gradle, an IDE and CI all disagree about the working directory, and a
   * hard coded relative path fails on two of the three — quietly, by finding
   * nothing, which would let the suite pass while testing an empty set.
   */
  private fun fixturesDir(): File {
    var dir: File? = File(".").absoluteFile
    while (dir != null) {
      val candidate = File(dir, "packages/pricing-spec/fixtures")
      if (candidate.isDirectory) return candidate
      dir = dir.parentFile
    }
    fail("could not find packages/pricing-spec/fixtures from ${File(".").absolutePath}")
    error("unreachable")
  }

  private fun run(operation: String, case: Map<String, Any?>): Any {
    @Suppress("UNCHECKED_CAST")
    fun weights() = (case["weights"] as List<String>).map { Money.ofMinor(it.toLong()) }

    return when (operation) {
      "applyRate" ->
        Money.ofMinor((case["amount"] as String).toLong())
          .applyRate(case["rate"] as String)
          .minor.toString()

      "allocate" ->
        Money.ofMinor((case["amount"] as String).toLong())
          .allocate((case["parts"] as String).toInt())
          .map { it.minor.toString() }

      "allocateByWeight" ->
        Money.ofMinor((case["amount"] as String).toLong())
          .allocateByWeight(weights())
          .map { it.minor.toString() }

      "costToMinor" ->
        costToMinor(case["cost"] as String, (case["quantity"] as String).toInt())
          .minor.toString()

      else -> throw IllegalArgumentException(
        "fixture uses an operation the runner does not know: $operation",
      )
    }
  }

  @Test
  fun `both engines agree on every fixture`() {
    val files = fixturesDir().listFiles { f -> f.extension == "json" }?.sorted().orEmpty()
    assertTrue(
      "no fixtures found — the suite must never pass vacuously",
      files.isNotEmpty(),
    )

    var checked = 0

    for (file in files) {
      val spec = json.parseToJsonElement(file.readText()).jsonObject
      val operation = spec["operation"]!!.jsonPrimitive.content
      val cases = spec["cases"]!!.jsonArray

      assertTrue("${file.name} has no cases", cases.isNotEmpty())

      for (element in cases) {
        val obj = element.jsonObject
        val name = obj["name"]!!.jsonPrimitive.content
        val label = "${file.name}: $name"

        // Everything is carried as a string so the fixture cannot depend on a
        // language's number parsing — which is precisely the class of
        // difference this suite exists to catch.
        val case = buildMap<String, Any?> {
          obj["amount"]?.let { put("amount", it.jsonPrimitive.content) }
          obj["rate"]?.let { put("rate", it.jsonPrimitive.content) }
          obj["cost"]?.let { put("cost", it.jsonPrimitive.content) }
          obj["parts"]?.let { put("parts", it.jsonPrimitive.content) }
          obj["quantity"]?.let { put("quantity", it.jsonPrimitive.content) }
          obj["weights"]?.let {
            put("weights", it.jsonArray.map { w -> w.jsonPrimitive.content })
          }
        }

        val expectsError = obj["expectError"]?.jsonPrimitive?.content == "true"

        if (expectsError) {
          var threw = false
          try {
            run(operation, case)
          } catch (e: Exception) {
            threw = true
          }
          assertTrue("$label: expected this to be refused, and it was not", threw)
        } else {
          val expected: Any = obj["expect"]!!.let {
            if (it is kotlinx.serialization.json.JsonArray) {
              it.map { v -> v.jsonPrimitive.content }
            } else {
              it.jsonPrimitive.content
            }
          }
          assertEquals(label, expected, run(operation, case))
        }
        checked++
      }
    }

    // A guard against the suite silently becoming a no-op: if the fixtures move
    // or the parser stops finding cases, this fails rather than passing.
    assertTrue("only $checked cases ran; the suite should cover far more", checked >= 40)
    println("pricing conformance: $checked cases across ${files.size} fixtures")
  }
}
