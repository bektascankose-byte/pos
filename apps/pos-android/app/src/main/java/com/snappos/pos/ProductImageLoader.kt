package com.snappos.pos

import android.content.Context
import coil.ImageLoader
import coil.disk.DiskCache
import coil.memory.MemoryCache
import com.snappos.sync.BaseUrlInterceptor
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import okhttp3.OkHttpClient
import javax.inject.Singleton

/**
 * Product photos on the register.
 *
 * Built on the same `OkHttpClient` everything else syncs through, which is
 * what makes this work at all: that client already carries the bearer token
 * and already rewrites the host to whichever server this register is pointed
 * at. An image loader with its own client would be unauthenticated and aimed
 * at nothing.
 *
 * **Photos are a convenience, not a fact the till depends on.** A price or an
 * age rule has to be right offline or the shop cannot trade; a missing picture
 * costs a cashier a second of recognition. So these are fetched lazily and
 * kept, rather than bulk-downloaded during sync — which would make every full
 * sync drag hundreds of files across a shop's uplink for something the
 * cashier may never look at.
 *
 * The disk cache is generous and effectively permanent. An image's address
 * never changes meaning — replacing a photo creates a new row with a new id —
 * so anything downloaded once stays correct forever, and a register that has
 * shown an item before keeps showing its picture with no network at all.
 */
@Module
@InstallIn(SingletonComponent::class)
object ProductImageModule {

  @Provides
  @Singleton
  fun imageLoader(@ApplicationContext context: Context, client: OkHttpClient): ImageLoader =
    ImageLoader.Builder(context)
      .okHttpClient(client)
      .memoryCache {
        // Thumbnails are a couple of kilobytes each; a modest share of heap
        // holds an entire shop's grid without pressuring anything else.
        MemoryCache.Builder(context).maxSizePercent(0.15).build()
      }
      .diskCache {
        DiskCache.Builder()
          .directory(context.cacheDir.resolve("product_images"))
          .maxSizeBytes(64L * 1024 * 1024)
          .build()
      }
      // Nothing is drawn while a request is in flight and nothing flashes when
      // it lands: a tile that pops a picture in under a cashier's finger is
      // worse than one that quietly gains it.
      .crossfade(false)
      .build()
}

/**
 * The absolute URL for a photo whose server-relative path came down with the
 * catalog.
 *
 * Built against the same placeholder host Retrofit uses, because the shared
 * client's `BaseUrlInterceptor` replaces scheme, host and port on every
 * request and keeps the path. Resolving the real host here instead would mean
 * reading the config from inside a composable, and would go stale the moment
 * the register was pointed somewhere else.
 */
fun productImageUrl(path: String): String = BaseUrlInterceptor.PLACEHOLDER.trimEnd('/') + path
