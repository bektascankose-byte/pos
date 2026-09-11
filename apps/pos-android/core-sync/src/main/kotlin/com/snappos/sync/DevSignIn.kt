package com.snappos.sync

import android.util.Log
import com.snappos.data.dao.ConfigDao
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Signing the register in, for development only.
 *
 * A real register is **claimed**: a manager signs in once on the device, the
 * server issues a device record, and the register holds a rotating refresh
 * token from then on. That flow needs a setup screen, a device claim endpoint
 * and a manager present, none of which exist yet.
 *
 * Until they do, this signs in with the seeded development credentials so the
 * sync path can be exercised end to end on real hardware. It is the same
 * compromise as `DevSeed`, with the same expiry date: **delete this the moment
 * the claim flow lands.** Credentials compiled into an APK are exactly the
 * thing a stolen terminal should not be carrying, and the only reason it is
 * tolerable now is that this APK is a debug build talking to a laptop over USB.
 */
@Singleton
class DevSignIn @Inject constructor(
  private val api: SnapPosApi,
  private val auth: AuthStore,
  private val config: ConfigDao,
) {

  suspend fun ensureSignedIn(): Boolean {
    // Holding a token is not the same as being signed in. A token can outlive
    // the user it names — the account is deleted, the register is moved to
    // another organization, the token family is revoked after a suspected
    // theft — and the symptom is not an error but an empty catalog, which
    // looks exactly like a register that simply has no products.
    //
    // So the token is verified, not assumed, and a dead one is cleared and
    // replaced rather than used forever.
    if (auth.isSignedIn()) {
      val session = runCatching { api.session() }.getOrNull()
      if (session?.isSuccessful == true) return true
      if (session != null && session.code() in 400..499) {
        Log.w(TAG, "stored credentials are no longer valid (HTTP ${session.code()}); signing in again")
        auth.clear()
      } else {
        // Could not reach the server at all. The stored token is probably fine;
        // this is a network problem, and clearing it would sign a register out
        // for the duration of an outage.
        return session != null
      }
    }

    val deviceId = config.get()?.deviceId
    val response = try {
      api.login(LoginRequest(DEV_EMAIL, DEV_PASSWORD, deviceId))
    } catch (e: Exception) {
      Log.i(TAG, "sign in could not reach the server: ${e.message}")
      return false
    }

    val body = response.body()
    if (!response.isSuccessful || body == null) {
      Log.w(TAG, "sign in refused: HTTP ${response.code()}")
      return false
    }

    auth.save(body.access_token, body.refresh_token)

    // The signed-in user is who sales are attributed to. Without this the
    // register would name a placeholder and every upload would fail a foreign
    // key, landing real sales in the dead letter list for a reason no manager
    // could act on.
    runCatching { api.session() }.getOrNull()?.body()?.user_id?.let { config.setCashier(it) }

    Log.i(TAG, "signed in as $DEV_EMAIL")
    return true
  }

  /**
   * Point the register at the real store and register the server knows about.
   *
   * `DevSeed` writes placeholder ids so the device can work before it has ever
   * seen a server. Once signed in, the actual ids replace them — otherwise
   * every uploaded sale would reference a store that does not exist and be
   * rejected as a foreign key violation, which is a confusing way to discover
   * that a register was never claimed.
   */
  suspend fun adoptServerIdentity(): Boolean {
    val current = config.get() ?: return false

    val stores = runCatching { api.stores() }.getOrNull()?.body()?.data.orEmpty()
    val registers = runCatching { api.registers() }.getOrNull()?.body()?.data.orEmpty()

    val store = stores.firstOrNull() ?: return false
    val register = registers.firstOrNull { it.store_id == store.id } ?: return false

    // Resume the receipt sequence where the server says this register got to.
    // The counter lives on the device so a receipt can print with no network,
    // which means a wiped or replaced terminal restarts at 1 and collides with
    // receipt numbers that already exist — the upload is then rejected by a
    // unique constraint and a legitimate sale can never be handed over.
    val serverSequence = register.last_sequence.toLongOrNull() ?: 0L
    val resumeFrom = maxOf(current.nextSequence, serverSequence + 1)

    val identityUnchanged =
      current.storeId == store.id && current.registerId == register.id
    if (identityUnchanged && current.nextSequence >= resumeFrom) return true

    config.upsert(
      current.copy(
        storeId = store.id,
        storeCode = store.code,
        storeName = store.name,
        registerId = register.id,
        registerCode = register.code,
        nextSequence = resumeFrom,
      ),
    )
    Log.i(
      TAG,
      "adopted ${store.code}/${register.code}; receipts resume at $resumeFrom",
    )
    return true
  }

  private companion object {
    const val TAG = "DevSignIn"
    const val DEV_EMAIL = "cashier@hhsmoke.test"
    const val DEV_PASSWORD = "dev-password-change-me"
  }
}
