package com.snappos.pos

import android.content.Context
import com.snappos.hardware.PrinterProvider
import com.snappos.hardware.star.UsbStarPrinter
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/**
 * The one place a concrete device is named.
 *
 * Everything else asks for a `PrinterProvider`. The shop's till has a Star
 * TSP143IIIU on USB with the cash drawer on its drawer port; a register with a
 * different printer changes this line and nothing else. On a device with no
 * Star printer attached the provider simply reports that, so the same build
 * runs on a phone.
 */
@Module
@InstallIn(SingletonComponent::class)
object HardwareModule {

  @Provides
  @Singleton
  fun printer(@ApplicationContext context: Context): PrinterProvider = UsbStarPrinter(context)
}
