package com.snappos.pos

import android.app.Application
import androidx.hilt.work.HiltWorkerFactory
import androidx.work.Configuration
import com.snappos.sync.ConnectivityWatcher
import com.snappos.sync.SyncWorker
import dagger.hilt.android.HiltAndroidApp
import javax.inject.Inject

@HiltAndroidApp
class SnapPosApplication : Application(), Configuration.Provider {

  @Inject lateinit var workerFactory: HiltWorkerFactory

  @Inject lateinit var connectivity: ConnectivityWatcher

  override val workManagerConfiguration: Configuration
    get() = Configuration.Builder().setWorkerFactory(workerFactory).build()

  override fun onCreate() {
    super.onCreate()
    // The safety net. A sale normally uploads within seconds because committing
    // one enqueues an immediate run; this catches the register that sat offline
    // all afternoon and came back at closing.
    SyncWorker.schedulePeriodic(this)

    // And the fast path: hand the sales over the moment the network returns,
    // rather than waiting up to fifteen minutes for the net above to notice.
    connectivity.start()
  }
}
