/**
 * Interfaces only. No implementation, no vendor SDK, no Android dependency.
 *
 * This module is what checkout is allowed to import. A printer that is out of
 * paper, a drawer that is unplugged, or a scanner from a vendor whose SDK
 * changes next year must never be able to stop a sale from completing, and the
 * only reliable way to guarantee that is for the sale path to have no way to
 * reference a concrete device.
 */
plugins {
  alias(libs.plugins.kotlin.jvm)
}

kotlin { jvmToolchain(17) }

dependencies {
  implementation(libs.kotlinx.coroutines.core)
  api(project(":core-domain"))
}
