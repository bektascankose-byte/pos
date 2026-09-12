package com.snappos.data.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Upsert
import com.snappos.data.entities.HeldCartEntity
import com.snappos.data.entities.HeldCartLineEntity
import kotlinx.coroutines.flow.Flow

@Dao
interface HoldsDao {
  @Query("SELECT * FROM held_carts ORDER BY updatedAtMillis DESC")
  fun observeAll(): Flow<List<HeldCartEntity>>

  @Query("SELECT * FROM held_carts WHERE id = :id")
  suspend fun byId(id: String): HeldCartEntity?

  @Query("SELECT * FROM held_cart_lines WHERE heldCartId = :id ORDER BY lineNo")
  suspend fun lines(id: String): List<HeldCartLineEntity>

  @Upsert suspend fun upsertCart(cart: HeldCartEntity)

  @Insert(onConflict = OnConflictStrategy.REPLACE)
  suspend fun insertLines(lines: List<HeldCartLineEntity>)

  @Query("DELETE FROM held_cart_lines WHERE heldCartId = :id")
  suspend fun deleteLines(id: String)

  @Query("DELETE FROM held_carts WHERE id = :id")
  suspend fun deleteCart(id: String)

  @Transaction
  suspend fun save(cart: HeldCartEntity, lines: List<HeldCartLineEntity>) {
    upsertCart(cart)
    deleteLines(cart.id)
    insertLines(lines)
  }

  @Transaction
  suspend fun take(id: String): Pair<HeldCartEntity, List<HeldCartLineEntity>>? {
    val cart = byId(id) ?: return null
    val cartLines = lines(id)
    deleteLines(id)
    deleteCart(id)
    return cart to cartLines
  }
}
