package com.snappos.sync

import android.util.Log
import kotlinx.serialization.json.Json
import retrofit2.Response
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Attaching a customer to a sale.
 *
 * Every call here reaches the network — see [SnapPosApi]'s class doc for why
 * a customer is looked up live rather than held on the device. That makes
 * this repository different from everything else under `core-data`: there is
 * no local fallback, so a register with no signal simply cannot attach a
 * customer that moment. The sale itself is unaffected either way, since
 * `Cart.customerId` is optional.
 */
@Singleton
class CustomerRepository @Inject constructor(
  private val api: SnapPosApi,
  private val json: Json,
) {

  /** Exactly one of `phone` or `q` is sent — the server refuses both blank. */
  suspend fun search(phone: String? = null, q: String? = null): Result<List<CustomerDto>> {
    val cleanPhone = phone?.trim()?.takeIf { it.isNotEmpty() }
    val cleanQuery = q?.trim()?.takeIf { it.isNotEmpty() }
    if (cleanPhone == null && cleanQuery == null) return Result.success(emptyList())

    val response = try {
      api.searchCustomers(phone = cleanPhone, q = cleanQuery)
    } catch (e: Exception) {
      Log.i(TAG, "customer search could not reach the server: ${e.message}")
      return Result.failure(IllegalStateException("no connection to look up a customer", e))
    }

    val body = response.body()
    if (!response.isSuccessful || body == null) {
      return Result.failure(IllegalStateException(describeError(response)))
    }
    return Result.success(body.data)
  }

  /**
   * Re-resolve a customer by id, for display only — a held cart carries the
   * id (it survives a hold like any other field on the sale), never a name.
   */
  suspend fun get(id: String): Result<CustomerDto> {
    val response = try {
      api.getCustomer(id)
    } catch (e: Exception) {
      return Result.failure(IllegalStateException("no connection to look up a customer", e))
    }
    val body = response.body()
    if (!response.isSuccessful || body == null) {
      return Result.failure(IllegalStateException(describeError(response)))
    }
    return Result.success(body)
  }

  /** A new walk-in. The server refuses one with neither a phone nor an email. */
  suspend fun create(
    firstName: String?,
    lastName: String?,
    phone: String?,
    email: String?,
  ): Result<CustomerDto> {
    val response = try {
      api.createCustomer(
        CreateCustomerRequest(
          first_name = firstName?.trim()?.takeIf { it.isNotEmpty() },
          last_name = lastName?.trim()?.takeIf { it.isNotEmpty() },
          phone = phone?.trim()?.takeIf { it.isNotEmpty() },
          email = email?.trim()?.takeIf { it.isNotEmpty() },
        ),
      )
    } catch (e: Exception) {
      Log.i(TAG, "customer create could not reach the server: ${e.message}")
      return Result.failure(IllegalStateException("no connection to add a customer", e))
    }

    val body = response.body()
    if (!response.isSuccessful || body == null) {
      return Result.failure(IllegalStateException(describeError(response)))
    }
    return Result.success(body)
  }

  /** The server's own `user_message` when it sent one, else a generic refusal. */
  private fun describeError(response: Response<*>): String {
    val raw = response.errorBody()?.string()
    val parsed = raw?.let { runCatching { json.decodeFromString(ApiErrorBody.serializer(), it) }.getOrNull() }
    return parsed?.userMessage ?: parsed?.message ?: "customer request failed (HTTP ${response.code()})"
  }

  private companion object {
    const val TAG = "CustomerRepository"
  }
}
