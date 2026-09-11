/**
 * Pure Kotlin. No Android dependency of any kind.
 *
 * This is deliberate and enforced: the pricing engine and the cart model live
 * here, they run as plain JVM unit tests in milliseconds, and the pricing
 * conformance suite has to be cheap enough to run on every commit. An
 * `android.*` import here would drag the whole test suite onto an emulator.
 */
plugins {
  alias(libs.plugins.kotlin.jvm)
  alias(libs.plugins.kotlin.serialization)
}

kotlin {
  jvmToolchain(17)
}

dependencies {
  implementation(libs.kotlinx.coroutines.core)
  implementation(libs.kotlinx.serialization.json)
  testImplementation(libs.junit)
  testImplementation(libs.kotlinx.coroutines.test)
}
