package com.snappos.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import com.snappos.data.dao.CashDao
import com.snappos.data.dao.CatalogDao
import com.snappos.data.dao.ConfigDao
import com.snappos.data.dao.EmployeeDao
import com.snappos.data.dao.OutboxDao
import com.snappos.data.dao.RefundsDao
import com.snappos.data.dao.SalesDao
import com.snappos.data.dao.HoldsDao
import com.snappos.data.entities.AgeVerificationEntity
import com.snappos.data.entities.CashMovementEntity
import com.snappos.data.entities.CashSessionEntity
import com.snappos.data.entities.BarcodeEntity
import com.snappos.data.entities.CategoryEntity
import com.snappos.data.entities.EmployeeEntity
import com.snappos.data.entities.InventoryEntity
import com.snappos.data.entities.OutboxEntity
import com.snappos.data.entities.PaymentEntity
import com.snappos.data.entities.PriceEntity
import com.snappos.data.entities.RefundEntity
import com.snappos.data.entities.RefundLineEntity
import com.snappos.data.entities.RegisterConfigEntity
import com.snappos.data.entities.SaleEntity
import com.snappos.data.entities.SaleLineEntity
import com.snappos.data.entities.VariantEntity
import com.snappos.data.entities.HeldCartEntity
import com.snappos.data.entities.HeldCartLineEntity
import net.zetetic.database.sqlcipher.SupportOpenHelperFactory

@Database(
  entities = [
    VariantEntity::class,
    BarcodeEntity::class,
    PriceEntity::class,
    CategoryEntity::class,
    InventoryEntity::class,
    EmployeeEntity::class,
    SaleEntity::class,
    SaleLineEntity::class,
    PaymentEntity::class,
    AgeVerificationEntity::class,
    OutboxEntity::class,
    RegisterConfigEntity::class,
    CashSessionEntity::class,
    CashMovementEntity::class,
    RefundEntity::class,
    RefundLineEntity::class,
    HeldCartEntity::class,
    HeldCartLineEntity::class,
  ],
  version = 4,
  exportSchema = true,
)
abstract class SnapPosDatabase : RoomDatabase() {
  abstract fun catalog(): CatalogDao
  abstract fun employees(): EmployeeDao
  abstract fun sales(): SalesDao
  abstract fun outbox(): OutboxDao
  abstract fun config(): ConfigDao
  abstract fun cash(): CashDao
  abstract fun refunds(): RefundsDao
  abstract fun holds(): HoldsDao

  companion object {
    const val NAME = "snappos.db"

    /**
     * Open the encrypted database.
     *
     * SQLCipher with a key from the Android Keystore. A terminal behind a
     * counter is a device that gets stolen, and this file holds the whole
     * catalog, employee PIN hashes, and every sale taken since the last
     * successful sync.
     *
     * **No `fallbackToDestructiveMigration`.** Room's destructive fallback
     * silently drops and recreates the database on a version mismatch, which
     * here would delete completed sales that have not yet uploaded. On a POS
     * that is not a migration strategy, it is data loss with a friendly name.
     * A missing migration must fail loudly instead.
     */
    fun open(context: Context, passphrase: ByteArray): SnapPosDatabase {
      System.loadLibrary("sqlcipher")
      return Room.databaseBuilder(context, SnapPosDatabase::class.java, NAME)
        .openHelperFactory(SupportOpenHelperFactory(passphrase))
        .addMigrations(*Migrations.ALL)
        .build()
    }

    /** In-memory and unencrypted, for instrumentation tests only. */
    fun inMemory(context: Context): SnapPosDatabase =
      Room.inMemoryDatabaseBuilder(context, SnapPosDatabase::class.java)
        .allowMainThreadQueries()
        .build()
  }
}
