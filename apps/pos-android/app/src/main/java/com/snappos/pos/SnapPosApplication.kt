package com.snappos.pos

import android.app.Application
import androidx.hilt.work.HiltWorkerFactory
import coil.ImageLoader
import coil.ImageLoaderFactory
import androidx.work.Configuration
import com.snappos.sync.ConnectivityWatcher
import com.snappos.sync.SyncWorker
import dagger.hilt.android.HiltAndroidApp
import javax.inject.Inject

@HiltAndroidApp
class SnapPosApplication : Application(), Configuration.Provider, ImageLoaderFactory {

  @Inject lateinit var workerFactory: HiltWorkerFactory

  @Inject lateinit var connectivity: ConnectivityWatcher

  /**
   * Injected lazily: Coil asks for this the first time a photo is drawn, which
   * is after Hilt has finished building the graph.
   */
  @Inject lateinit var images: dagger.Lazy<ImageLoader>

  override val workManagerConfiguration: Configuration
    get() = Configuration.Builder().setWorkerFactory(workerFactory).build()

  /**
   * Hand Coil the register's own image loader.
   *
   * WITHOUT THIS, EVERY PRODUCT PHOTO SILENTLY FAILS. `AsyncImage` does not
   * read the dependency graph: it resolves `Coil.imageLoader(context)`, and if
   * the Application does not supply one, Coil quietly builds a default with a
   * stock `OkHttpClient`. That client has neither the bearer token nor the
   * `BaseUrlInterceptor`, so every request went out unauthenticated to the
   * literal placeholder host `register.invalid` and failed name resolution.
   *
   * Nothing reported it. Coil swallows a failed load into its error drawable,
   * which here is the monogram a photoless product is supposed to show -- so a
   * catalog with photos and a catalog whose photos all fail looked identical
   * on the grid, on the register, for as long as photos have existed.
   */
  override fun newImageLoader(): ImageLoader = images.get()

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
