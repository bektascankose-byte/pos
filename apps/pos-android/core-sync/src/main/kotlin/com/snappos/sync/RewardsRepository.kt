package com.snappos.sync

import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.Json
import retrofit2.Response
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Why a rewards call did not work.
 *
 * [offline] separates "the register cannot reach the server" from "the server
 * said no", because the customer is told different things: one is nobody's
 * fault and passes, the other will happen again if they retry. [userMessage]
 * is the server's own sentence for the customer when it sent one.
 */
class RewardsFailure(
  message: String,
  val userMessage: String? = null,
  val offline: Boolean = false,
  cause: Throwable? = null,
) : Exception(message, cause)

/**
 * The customer's own screen talking to the server.
 *
 * An interface so the flow that drives the screen can be tested against a
 * fake: what matters there is the order of the questions and what happens
 * when a sale finishes underneath them, not HTTP.
 */
interface RewardsGateway {
  /** The member with exactly this contact, or null when there is none. */
  suspend fun identify(contact: RewardsContactRequest): Result<RewardsMemberDto?>

  suspend fun join(contact: RewardsContactRequest): Result<RewardsMemberDto>

  /** False when the member already had a birthday, which is left as it was. */
  suspend fun saveBirthday(customerId: String, month: Int, day: Int): Result<Boolean>

  suspend fun saveOffers(customerId: String, channel: String, granted: Boolean, wording: String): Result<Boolean>
}

/**
 * Live, like every customer call: nothing about a customer is kept on the
 * register (see [SnapPosApi]). With no network the customer simply cannot
 * sign in for rewards that moment, and the sale goes ahead without them.
 *
 * Nothing here logs a phone number or an email. The log on a till is read by
 * whoever is debugging it, and who shops here is not part of that.
 */
@Singleton
class RewardsRepository @Inject constructor(
  private val api: SnapPosApi,
  private val json: Json,
) : RewardsGateway {

  override suspend fun identify(contact: RewardsContactRequest): Result<RewardsMemberDto?> =
    call("lookup") { api.rewardsIdentify(contact) }.map { if (it.found) it.member else null }

  override suspend fun join(contact: RewardsContactRequest): Result<RewardsMemberDto> =
    call("join") { api.rewardsJoin(contact) }

  override suspend fun saveBirthday(customerId: String, month: Int, day: Int): Result<Boolean> =
    call("birthday") { api.rewardsBirthday(customerId, RewardsBirthdayRequest(month, day)) }.map { it.saved }

  override suspend fun saveOffers(
    customerId: String,
    channel: String,
    granted: Boolean,
    wording: String,
  ): Result<Boolean> =
    call("offers") { api.rewardsOffers(customerId, RewardsOffersRequest(channel, granted, wording)) }
      .map { it.saved }

  private suspend fun <T : Any> call(what: String, request: suspend () -> Response<T>): Result<T> {
    val response = try {
      request()
    } catch (e: CancellationException) {
      // Not a failure to report. The caller stopped caring, and swallowing
      // this would let it carry on as if the network had dropped.
      throw e
    } catch (e: Exception) {
      Log.i(TAG, "rewards $what could not reach the server: ${e.javaClass.simpleName}")
      return Result.failure(RewardsFailure("no connection for rewards $what", offline = true, cause = e))
    }
    val body = response.body()
    if (response.isSuccessful && body != null) return Result.success(body)

    val raw = response.errorBody()?.string()
    val parsed = raw?.let { runCatching { json.decodeFromString(ApiErrorBody.serializer(), it) }.getOrNull() }
    Log.i(TAG, "rewards $what refused: HTTP ${response.code()} ${parsed?.code.orEmpty()}")
    return Result.failure(
      RewardsFailure(
        message = parsed?.message ?: "rewards $what failed (HTTP ${response.code()})",
        userMessage = parsed?.userMessage,
      ),
    )
  }

  private companion object {
    const val TAG = "RewardsRepository"
  }
}
