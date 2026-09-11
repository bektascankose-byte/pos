package com.snappos.data.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import com.snappos.data.entities.CashMovementEntity
import com.snappos.data.entities.CashSessionEntity
import com.snappos.data.entities.OutboxEntity
import kotlinx.coroutines.flow.Flow

@Dao
interface CashDao {

  /**
   * Open a drawer and queue it, in one transaction.
   *
   * Same rule as a sale: the session and its outbox row land together or not at
   * all. A session the server never hears about would make every movement in it
   * an orphan on upload.
   */
  @Transaction
  suspend fun openSession(
    session: CashSessionEntity,
    openingFloat: CashMovementEntity,
    outbox: OutboxEntity,
  ) {
    insertSession(session)
    insertMovement(openingFloat)
    insertOutbox(outbox)
  }

  @Insert(onConflict = OnConflictStrategy.IGNORE)
  suspend fun insertSession(session: CashSessionEntity)

  @Insert(onConflict = OnConflictStrategy.IGNORE)
  suspend fun insertMovement(movement: CashMovementEntity)

  @Insert(onConflict = OnConflictStrategy.IGNORE)
  suspend fun insertOutbox(entry: OutboxEntity)

  @Query("SELECT * FROM cash_sessions WHERE registerId = :registerId AND closedAtMillis IS NULL LIMIT 1")
  suspend fun openSessionFor(registerId: String): CashSessionEntity?

  @Query("SELECT * FROM cash_sessions WHERE registerId = :registerId AND closedAtMillis IS NULL LIMIT 1")
  fun observeOpenSession(registerId: String): Flow<CashSessionEntity?>

  @Query("SELECT * FROM cash_sessions WHERE id = :id")
  suspend fun sessionById(id: String): CashSessionEntity?

  /** Expected cash: the sum of every movement, computed rather than stored. */
  @Query("SELECT COALESCE(sum(amountMinor), 0) FROM cash_movements WHERE sessionId = :sessionId")
  suspend fun expectedCash(sessionId: String): Long

  @Query("SELECT * FROM cash_movements WHERE sessionId = :sessionId ORDER BY occurredAtMillis")
  suspend fun movements(sessionId: String): List<CashMovementEntity>

  @Query("SELECT kind, sum(amountMinor) AS total, count(*) AS count FROM cash_movements WHERE sessionId = :sessionId GROUP BY kind")
  suspend fun breakdown(sessionId: String): List<CashBreakdownRow>

  @Query(
    """
    UPDATE cash_sessions
    SET closedBy = :closedBy, closedAtMillis = :closedAt,
        countedMinor = :counted, expectedMinor = :expected, note = :note
    WHERE id = :id
    """,
  )
  suspend fun closeSession(
    id: String,
    closedBy: String,
    closedAt: Long,
    counted: Long,
    expected: Long,
    note: String?,
  )
}

data class CashBreakdownRow(val kind: String, val total: Long, val count: Int)
