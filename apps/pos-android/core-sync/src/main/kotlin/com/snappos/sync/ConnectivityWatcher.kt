package com.snappos.sync

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.util.Log
import dagger.hilt.android.qualifiers.ApplicationContext
import java.util.concurrent.atomic.AtomicBoolean
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Hand the day's sales over the moment the network comes back.
 *
 * Without this a register that lost its connection sits on completed sales
 * until something else happens to trigger a sync. WorkManager's `CONNECTED`
 * constraint is not enough on its own: by the time the network returns the
 * upload worker has usually failed once and been rescheduled with an
 * exponential backoff, and a satisfied constraint does not shorten that delay.
 * So the shop's internet comes back, the register still says *pending*, and it
 * stays that way for minutes — which looks exactly like the sync being broken,
 * on the one screen a shopkeeper is inclined to distrust.
 *
 * `syncNow` enqueues with `REPLACE`, which cancels the backed-off run and
 * starts a fresh one, so the backoff is cleared rather than waited out.
 *
 * **What this does not cover.** It fires on *connectivity* changing, not on the
 * server becoming reachable. A register whose wifi is perfectly healthy while
 * the API is down gets no callback here, because from Android's point of view
 * nothing changed. That case is caught by the periodic job and by the next sale
 * — both of which also clear the backoff — and closing it properly would mean
 * polling a server that is, by definition, already failing to answer.
 */
@Singleton
class ConnectivityWatcher @Inject constructor(
  @ApplicationContext private val context: Context,
) {

  private val started = AtomicBoolean(false)

  /**
   * Whether the last callback told us we had usable internet.
   *
   * Kept because the callbacks are noisy: switching from wifi to mobile, a
   * captive portal resolving, or the radio re-associating all produce events
   * while the register was online throughout. Syncing on every one of those
   * would have a busy till hammering the endpoint for no reason, so only an
   * actual transition into "usable" triggers an upload.
   */
  private var online = false

  fun start() {
    // Registered for the life of the process and never unregistered, which is
    // deliberate: a register is a single-purpose device that runs one app all
    // day, and the case this exists for is precisely the app sitting idle while
    // the network comes back.
    if (!started.compareAndSet(false, true)) return

    val manager = context.getSystemService(ConnectivityManager::class.java) ?: run {
      Log.w(TAG, "no ConnectivityManager; sync will rely on the periodic job")
      return
    }

    manager.registerDefaultNetworkCallback(
      object : ConnectivityManager.NetworkCallback() {

        override fun onCapabilitiesChanged(
          network: Network,
          capabilities: NetworkCapabilities,
        ) {
          // VALIDATED, not merely connected. Associated with an access point
          // that has not yet proved it can reach anything is the state a
          // register is in for a second or two every time it walks back into
          // range, and uploading into it just burns a retry.
          val usable =
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
              capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)

          if (usable && !online) {
            online = true
            Log.i(TAG, "network usable again; draining the outbox")
            SyncWorker.syncNow(context)
          } else if (!usable) {
            online = false
          }
        }

        override fun onLost(network: Network) {
          online = false
        }
      },
    )
  }

  private companion object {
    const val TAG = "ConnectivityWatcher"
  }
}
