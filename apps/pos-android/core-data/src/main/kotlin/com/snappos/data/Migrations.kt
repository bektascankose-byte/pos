package com.snappos.data

import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

/**
 * Schema migrations.
 *
 * Written by hand and never skipped. `SnapPosDatabase` deliberately does not
 * enable `fallbackToDestructiveMigration`, because Room's destructive fallback
 * would drop and recreate the database on a version mismatch — and on a
 * register that means deleting completed sales that have not uploaded yet. A
 * missing migration has to fail loudly instead.
 */
object Migrations {

  /**
   * 1 -> 2: refunds on the device.
   *
   * Adds the refund tables and `quantityRefunded` on a sale line, which is what
   * makes refunding more than was sold checkable at the counter rather than
   * only on upload.
   */
  val MIGRATION_1_2 = object : Migration(1, 2) {
    override fun migrate(db: SupportSQLiteDatabase) {
      db.execSQL(
        "ALTER TABLE sale_lines ADD COLUMN quantityRefunded TEXT NOT NULL DEFAULT '0'",
      )

      db.execSQL(
        """
        CREATE TABLE IF NOT EXISTS refunds (
          id TEXT NOT NULL PRIMARY KEY,
          storeId TEXT NOT NULL,
          registerId TEXT NOT NULL,
          sessionId TEXT,
          originalSaleId TEXT,
          cashierUserId TEXT NOT NULL,
          approvedBy TEXT,
          receiptNo TEXT NOT NULL,
          reasonCode TEXT NOT NULL,
          reasonNote TEXT,
          subtotalMinor INTEGER NOT NULL,
          taxMinor INTEGER NOT NULL,
          totalMinor INTEGER NOT NULL,
          restock INTEGER NOT NULL,
          deviceTimeMillis INTEGER NOT NULL,
          completedAtMillis INTEGER NOT NULL,
          syncState TEXT NOT NULL
        )
        """.trimIndent(),
      )
      db.execSQL("CREATE INDEX IF NOT EXISTS index_refunds_syncState ON refunds (syncState)")
      db.execSQL("CREATE INDEX IF NOT EXISTS index_refunds_originalSaleId ON refunds (originalSaleId)")
      db.execSQL(
        "CREATE INDEX IF NOT EXISTS index_refunds_completedAtMillis ON refunds (completedAtMillis)",
      )

      db.execSQL(
        """
        CREATE TABLE IF NOT EXISTS refund_lines (
          id TEXT NOT NULL PRIMARY KEY,
          refundId TEXT NOT NULL,
          saleLineId TEXT,
          variantId TEXT NOT NULL,
          description TEXT NOT NULL,
          quantity TEXT NOT NULL,
          unitPriceMinor INTEGER NOT NULL,
          taxMinor INTEGER NOT NULL,
          totalMinor INTEGER NOT NULL,
          unitCost TEXT NOT NULL,
          restocked INTEGER NOT NULL,
          condition TEXT
        )
        """.trimIndent(),
      )
      db.execSQL("CREATE INDEX IF NOT EXISTS index_refund_lines_refundId ON refund_lines (refundId)")
      db.execSQL(
        "CREATE INDEX IF NOT EXISTS index_refund_lines_saleLineId ON refund_lines (saleLineId)",
      )
    }
  }

  /**
   * 2 -> 3: voiding on the device.
   *
   * Three nullable columns on `sales`. Nullable rather than defaulted because a
   * void is the exception, and a default would claim every historical sale had
   * been voided by nobody at the epoch.
   */
  val MIGRATION_2_3 = object : Migration(2, 3) {
    override fun migrate(db: SupportSQLiteDatabase) {
      db.execSQL("ALTER TABLE sales ADD COLUMN voidedAtMillis INTEGER")
      db.execSQL("ALTER TABLE sales ADD COLUMN voidedBy TEXT")
      db.execSQL("ALTER TABLE sales ADD COLUMN voidReason TEXT")
    }
  }

  val ALL = arrayOf(MIGRATION_1_2, MIGRATION_2_3)
}
