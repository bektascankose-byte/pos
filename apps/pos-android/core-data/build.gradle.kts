plugins {
  alias(libs.plugins.android.library)
  alias(libs.plugins.kotlin.android)
  alias(libs.plugins.kotlin.serialization)
  alias(libs.plugins.ksp)
  alias(libs.plugins.hilt)
}

android {
  namespace = "com.snappos.data"
  compileSdk = 36

  defaultConfig {
    minSdk = 26
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlin { jvmToolchain(17) }
}

dependencies {
  implementation(project(":core-domain"))

  implementation(libs.room.runtime)
  implementation(libs.room.ktx)
  ksp(libs.room.compiler)

  // The register holds the catalog, prices, employee PIN hashes and completed
  // sales that have not uploaded yet. A terminal behind a counter is a device
  // that gets stolen, so the file is encrypted with a key held in the Android
  // Keystore rather than in the APK.
  implementation(libs.sqlcipher)
  implementation(libs.sqlite.ktx)

  implementation(libs.hilt.android)
  ksp(libs.hilt.compiler)

  implementation(libs.kotlinx.coroutines.android)
  implementation(libs.kotlinx.serialization.json)
  implementation(libs.datastore.preferences)

  testImplementation(libs.junit)
  testImplementation(libs.kotlinx.coroutines.test)
}
