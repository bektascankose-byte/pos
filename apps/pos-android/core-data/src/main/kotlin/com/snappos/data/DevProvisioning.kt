package com.snappos.data

import com.snappos.data.dao.ConfigDao
import com.snappos.data.entities.RegisterConfigEntity
import com.snappos.domain.Uuid7
import javax.inject.Inject
import javax.inject.Singleton

/**
 * How this device reaches its server, for development only.
 *
 * This replaced `DevSeed`, which also wrote a local catalog. That was the right
 * thing before `CatalogSync` existed and the wrong thing the moment it did:
 * the seeded variants and the pulled ones had different ids, so every product
 * appeared twice and a scan resolved to whichever row won the upsert. Two
 * sources of catalog truth is precisely how a register ends up disagreeing with
 * the shop about what things cost, and the seed's own comment said to delete it
 * for this reason.
 *
 * So the split is now the one a real claim flow uses:
 *
 *   provisioning  how to reach the server  — written here
 *   catalog       what we sell             — pulled from the server, only
 *
 * A real register is claimed: a manager signs in on the device, the server
 * issues a device record and returns the store and register it belongs to.
 * **Delete this when that flow lands.**
 */
@Singleton
class DevProvisioning @Inject constructor(private val config: ConfigDao) {

  suspend fun ensureProvisioned() {
    if (config.get() != null) return

    config.upsert(
      RegisterConfigEntity(
        orgId = PLACEHOLDER_ORG,
        // Placeholders. DevSignIn.adoptServerIdentity() replaces these with the
        // real store and register as soon as the device can reach the server;
        // until then they are only there so the row is well formed.
        storeId = PLACEHOLDER_STORE,
        storeCode = "HH01",
        storeName = "Harker Heights",
        registerId = PLACEHOLDER_REGISTER,
        registerCode = "R1",
        deviceId = Uuid7.generate(),
        // localhost on the device, tunnelled to the host by
        // `adb reverse tcp:3000 tcp:3000`. Chosen over the machine's LAN
        // address because it survives a VPN, a firewall and a change of wifi,
        // none of which a developer should have to debug to ring a test sale.
        apiBaseUrl = "http://localhost:3000",
        nextSequence = 1,
        // Replaced by the rate the catalog pull returns. A register with no
        // catalog cannot sell anything, so this value is never used to price a
        // real line.
        taxRate = "0",
        lastCatalogCursor = "0",
        clockOffsetMillis = 0,
      ),
    )
  }

  companion object {
    const val PLACEHOLDER_ORG = "00000000-0000-4000-8000-000000000001"
    const val PLACEHOLDER_STORE = "00000000-0000-4000-8000-000000000002"
    const val PLACEHOLDER_REGISTER = "00000000-0000-4000-8000-000000000003"

    /**
     * The cashier a sale is attributed to.
     *
     * Replaced by whoever unlocked the register once PIN unlock exists. Until
     * then this is the seeded cashier, so uploads reference a real user rather
     * than failing a foreign key.
     */
    const val DEV_CASHIER_ID = "00000000-0000-4000-8000-000000000004"
  }
}
