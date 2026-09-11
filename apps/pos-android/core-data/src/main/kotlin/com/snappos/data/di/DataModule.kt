package com.snappos.data.di

import android.content.Context
import com.snappos.data.SnapPosDatabase
import com.snappos.data.crypto.DatabaseKey
import com.snappos.data.dao.CatalogDao
import com.snappos.data.dao.ConfigDao
import com.snappos.data.dao.EmployeeDao
import com.snappos.data.dao.OutboxDao
import com.snappos.data.dao.SalesDao
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object DataModule {

  /**
   * The database is a singleton for the process lifetime.
   *
   * Opening it decrypts the SQLCipher passphrase from the Keystore, which is
   * cheap but not free, and more importantly two open handles on one encrypted
   * file is a way to get locking behaviour nobody wants during a rush.
   */
  @Provides
  @Singleton
  fun database(@ApplicationContext context: Context): SnapPosDatabase =
    SnapPosDatabase.open(context, DatabaseKey.get(context))

  @Provides fun catalogDao(db: SnapPosDatabase): CatalogDao = db.catalog()

  @Provides fun employeeDao(db: SnapPosDatabase): EmployeeDao = db.employees()

  @Provides fun salesDao(db: SnapPosDatabase): SalesDao = db.sales()

  @Provides fun outboxDao(db: SnapPosDatabase): OutboxDao = db.outbox()

  @Provides fun configDao(db: SnapPosDatabase): ConfigDao = db.config()
}
