package com.snappos.sync

import android.content.Context
import android.util.Log
import androidx.hilt.work.HiltWorker
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import java.util.concurrent.TimeUnit

/**
 * The background sync.
 *
 * WorkManager rather than a service or a timer, for one reason: it survives the
 * app being killed and the device rebooting. A register that was closed with
 * unuploaded sales must hand them over when it next has power and a network,
 * without anybody opening the app to make that happen.
 *
 * Upload first, then catalog. If only one of the two can run, handing over
 * sales matters more than learning about a price change.
 */
@HiltWorker
class SyncWorker @AssistedInject constructor(
  @Assisted context: Context,
  @Assisted params: WorkerParameters,
  private val uploader: SyncUploader,
  private val catalog: CatalogSync,
  private val auth: AuthStore,
) : CoroutineWorker(context, params) {

  override suspend fun doWork(): Result {
    if (!auth.isSignedIn()) {
      Log.i(TAG, "not signed in; nothing to sync")
      return Result.success()
    }

    val upload = uploader.drainAll()
    Log.i(
      TAG,
      "upload: ${upload.uploaded} accepted, ${upload.duplicates} duplicate, " +
        "${upload.rejected} rejected, ${upload.deadLettered} dead, ${upload.remaining} left",
    )

    if (inputData.getBoolean(PULL_CATALOG, true)) {
      val pulled = catalog.pull()
      if (!pulled.ok) Log.i(TAG, "catalog pull skipped: ${pulled.failure}")
    }

    // Retry only when something is still waiting AND the failure looked
    // transient. Returning retry for a dead lettered entity would have
    // WorkManager back off forever over something that will never succeed.
    return if (upload.remaining > 0 && upload.failure != null) Result.retry() else Result.success()
  }

  companion object {
    private const val TAG = "SyncWorker"
    const val PULL_CATALOG = "pull_catalog"
    private const val PERIODIC = "snappos-sync-periodic"
    private const val IMMEDIATE = "snappos-sync-now"

    /**
     * Every fifteen minutes, which is WorkManager's floor.
     *
     * The periodic job is the safety net rather than the main path: a sale
     * normally uploads within seconds because committing one enqueues an
     * immediate run. This is what catches the register that sat offline all
     * afternoon and came back at closing.
     */
    fun schedulePeriodic(context: Context) {
      WorkManager.getInstance(context).enqueueUniquePeriodicWork(
        PERIODIC,
        ExistingPeriodicWorkPolicy.KEEP,
        PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
          .setConstraints(
            Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build(),
          )
          .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
          .build(),
      )
    }

    /**
     * Run now. Called after every committed sale.
     *
     * `APPEND_OR_REPLACE` rather than `REPLACE`: a burst of sales during a rush
     * must not have each one cancel the upload of the one before it.
     */
    fun syncNow(context: Context, pullCatalog: Boolean = false) {
      WorkManager.getInstance(context).enqueueUniqueWork(
        IMMEDIATE,
        ExistingWorkPolicy.APPEND_OR_REPLACE,
        OneTimeWorkRequestBuilder<SyncWorker>()
          .setConstraints(
            Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build(),
          )
          .setInputData(androidx.work.workDataOf(PULL_CATALOG to pullCatalog))
          .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
          .build(),
      )
    }
  }
}
