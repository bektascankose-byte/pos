/**
 * Star Micronics receipt printers on USB, starting with the TSP143IIIU on the
 * shop's till.
 *
 * Its own module so the sale path still cannot see it: the app wires this in
 * as a `PrinterProvider` and checkout only ever talks to the interface in
 * `hardware-api`. No vendor SDK either. Star's StarXpand SDK does not list the
 * TSP100III over USB on Android, and what a receipt needs from the printer's
 * command set is four commands, so the dependency would buy nothing but a
 * second thing to keep working.
 */
plugins {
  alias(libs.plugins.android.library)
  alias(libs.plugins.kotlin.android)
}

android {
  namespace = "com.snappos.hardware.star"
  compileSdk = 36

  defaultConfig {
    minSdk = 26
  }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlin { jvmToolchain(17) }
}

dependencies {
  api(project(":hardware:hardware-api"))
  implementation(libs.androidx.core.ktx)
  implementation(libs.kotlinx.coroutines.android)

  testImplementation(libs.junit)
}
