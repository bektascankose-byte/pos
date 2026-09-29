/**
 * Pure Kotlin. No Android dependency of any kind.
 *
 * This is deliberate and enforced: the pricing engine and the cart model live
 * here, they run as plain JVM unit tests in milliseconds, and the pricing
 * conformance suite has to be cheap enough to run on every commit. An
 * `android.*` import here would drag the whole test suite onto an emulator.
 *
 * That independence has a cost, and it cost us a day. This module compiles and
 * tests against the JDK, so the JDK's whole standard library is in scope --
 * but the bytecode ships inside an APK and runs on Android's much older
 * `java.*`. `BigInteger.TWO` and `BigInteger.longValueExact()` are Java 8/9
 * members that Android only carries from API 31, so a shop register on Android
 * 11 threw `NoSuchFieldError` the first time a cashier tapped a product, while
 * every JVM test passed and every dev phone on Android 13 was fine. Android
 * Lint's `NewApi` check cannot see this module -- it only analyses Android
 * modules -- so nothing in the build was looking.
 *
 * Animal Sniffer is what looks now. It reads the compiled classes and rejects
 * any reference to a `java.*` member missing from the Android API signature
 * below, which is pinned to this project's minSdk.
 */
plugins {
  alias(libs.plugins.kotlin.jvm)
  alias(libs.plugins.kotlin.serialization)
  alias(libs.plugins.animalsniffer)
}

kotlin {
  jvmToolchain(17)
}

animalsniffer {
  // Main only. Tests run on the JDK and never ship.
  sourceSets = listOf(extensions.getByType<SourceSetContainer>()["main"])
}

// The plugin keeps a live `Configuration` on the task, which Gradle cannot
// serialise. Opting this one task out costs a few seconds on a check that runs
// once per build; turning the configuration cache off project-wide would cost
// far more on every other task.
tasks.withType<ru.vyarus.gradle.plugin.animalsniffer.AnimalSniffer>().configureEach {
  notCompatibleWithConfigurationCache("holds an unresolved Configuration")
}

dependencies {
  // Must track `minSdk` in app/build.gradle.kts. Raising one without the other
  // makes this check either useless or wrong.
  signature("net.sf.androidscents.signature:android-api-level-26:${libs.versions.android.signature.get()}@signature")

  implementation(libs.kotlinx.coroutines.core)
  implementation(libs.kotlinx.serialization.json)
  testImplementation(libs.junit)
  testImplementation(libs.kotlinx.coroutines.test)
}
