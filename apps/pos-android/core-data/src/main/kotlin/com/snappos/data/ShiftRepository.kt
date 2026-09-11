package com.snappos.data

import com.lambdapioneer.argon2kt.Argon2Kt
import com.snappos.data.dao.ConfigDao
import com.snappos.data.dao.EmployeeDao
import com.snappos.data.entities.EmployeeEntity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.withContext
import javax.inject.Inject
import javax.inject.Singleton

/** Who is on the register, and what they may do. */
data class Cashier(
  val userId: String,
  val displayName: String,
  val permissions: Set<String>,
) {
  fun can(permission: String): Boolean = permission in permissions
}

sealed interface UnlockResult {
  data class Success(val cashier: Cashier) : UnlockResult
  data object WrongPin : UnlockResult
  data class LockedOut(val untilMillis: Long) : UnlockResult
  data object NoEmployees : UnlockResult
}

/**
 * Unlocking the register.
 *
 * Verified **on device**, against the Argon2id hash the server replicated. A
 * shift most often starts on a register that cannot reach anything — the shop
 * opens before the internet decides to cooperate — so an unlock that needs a
 * round trip is an unlock that fails when it matters.
 *
 * A four digit PIN is 10,000 combinations, so the hash was never the
 * protection. Three things are:
 *
 *   * the PIN only unlocks a device that a real login already claimed
 *   * five failures locks that employee out for fifteen minutes, counted
 *     locally, because that is where the attempts happen
 *   * it grants a cashier's permissions, not a manager's. Anything genuinely
 *     dangerous still needs a manager PIN, checked separately
 */
@Singleton
class ShiftRepository @Inject constructor(
  private val employees: EmployeeDao,
  private val config: ConfigDao,
) {

  private val argon2 = Argon2Kt()

  fun activeEmployees(): Flow<List<EmployeeEntity>> = employees.active()

  suspend fun unlock(userId: String, pin: String): UnlockResult {
    val employee = employees.byId(userId) ?: return UnlockResult.NoEmployees

    val lockedUntil = employee.lockedUntilMillis
    if (lockedUntil != null && lockedUntil > System.currentTimeMillis()) {
      return UnlockResult.LockedOut(lockedUntil)
    }

    // Argon2 is deliberately slow; keeping it off the main thread is what stops
    // the unlock screen from freezing for the duration.
    val matches = withContext(Dispatchers.Default) {
      runCatching {
        argon2.verify(
          mode = com.lambdapioneer.argon2kt.Argon2Mode.ARGON2_ID,
          encoded = employee.pinHash,
          password = pin.toByteArray(),
        )
      }.getOrDefault(false)
    }

    if (!matches) {
      val attempts = employee.failedPinAttempts + 1
      val lock = attempts >= MAX_ATTEMPTS
      val until = if (lock) System.currentTimeMillis() + LOCKOUT_MILLIS else null
      employees.recordPinAttempt(userId, if (lock) 0 else attempts, until)
      return if (lock) UnlockResult.LockedOut(until!!) else UnlockResult.WrongPin
    }

    employees.recordPinAttempt(userId, 0, null)

    // Sales are attributed to whoever unlocked, from this point on. Stored on
    // the config row rather than held in memory so a sale committed after the
    // process is restarted still names the right person.
    config.setCashier(userId)

    return UnlockResult.Success(
      Cashier(
        userId = employee.id,
        displayName = employee.displayName,
        permissions = employee.permissions
          .split(',')
          .map(String::trim)
          .filter(String::isNotEmpty)
          .toSet(),
      ),
    )
  }

  /**
   * Verify a manager's PIN for one privileged action, without changing who is
   * on the register.
   *
   * A price override or a refund is approved by a manager standing beside the
   * cashier; it must not sign the cashier out. The permission is checked here
   * too, so an employee with a valid PIN but no authority cannot approve
   * anything.
   */
  suspend fun approve(permission: String, pin: String): Cashier? {
    val candidates = employees.activeOnce()
    for (employee in candidates) {
      val permissions = employee.permissions.split(',').map(String::trim).toSet()
      if (permission !in permissions) continue

      val locked = employee.lockedUntilMillis?.let { it > System.currentTimeMillis() } ?: false
      if (locked) continue

      val matches = withContext(Dispatchers.Default) {
        runCatching {
          argon2.verify(
            mode = com.lambdapioneer.argon2kt.Argon2Mode.ARGON2_ID,
            encoded = employee.pinHash,
            password = pin.toByteArray(),
          )
        }.getOrDefault(false)
      }
      if (matches) {
        return Cashier(employee.id, employee.displayName, permissions)
      }
    }
    return null
  }

  suspend fun currentCashier(): Cashier? {
    val userId = config.get()?.cashierUserId ?: return null
    val employee = employees.byId(userId) ?: return null
    return Cashier(
      userId = employee.id,
      displayName = employee.displayName,
      permissions = employee.permissions.split(',').map(String::trim).filter(String::isNotEmpty).toSet(),
    )
  }

  private companion object {
    const val MAX_ATTEMPTS = 5
    const val LOCKOUT_MILLIS = 15 * 60 * 1000L
  }
}
