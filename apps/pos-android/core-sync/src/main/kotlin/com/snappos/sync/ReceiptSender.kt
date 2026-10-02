package com.snappos.sync

import android.util.Log
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Emailing or texting a customer their receipt.
 *
 * The one receipt action a register cannot carry out by itself. Printing is
 * local and works with the shop's internet down; sending needs a mail or text
 * provider, which lives server side.
 *
 * So this is a live call, and the result it returns is written to be read
 * aloud. The cashier is standing in front of the customer and is about to say
 * either "that's on its way" or "sorry, let me print it" -- they can only say
 * the true one if this hands them the true one. Nothing here reports success
 * it did not have.
 */
@Singleton
class ReceiptSender @Inject constructor(
  private val api: SnapPosApi,
) {

  /**
   * What happened, in a sentence.
   *
   * `delivered` is false for anything the customer will not receive, which
   * deliberately includes "saved until texting is switched on": saved is not
   * sent, and a cashier told otherwise will say otherwise.
   */
  data class Outcome(val note: String, val delivered: Boolean)

  /** `channel` is "email" or "sms". */
  suspend fun send(saleId: String, channel: String, destination: String, body: String): Outcome {
    val response = try {
      api.sendReceipt(saleId, SendReceiptRequest(channel, destination, body))
    } catch (e: Exception) {
      Log.i(TAG, "receipt could not be sent: ${e.message}")
      return Outcome("No connection, so it could not be sent. Print it instead.", delivered = false)
    }

    val sent = response.body()
    if (response.isSuccessful && sent != null) {
      return Outcome(sent.note, delivered = sent.status == "sent")
    }

    // The server's refusals are worded for this screen, so its sentence is
    // preferred over anything invented here.
    val message = humanMessage(response.errorBody()?.string())
    Log.w(TAG, "receipt refused with HTTP ${response.code()}")
    return Outcome(
      message ?: "The back office refused it (${response.code()}).",
      delivered = false,
    )
  }

  private fun humanMessage(body: String?): String? {
    if (body.isNullOrBlank()) return null
    return try {
      val obj = JSON.parseToJsonElement(body).jsonObject
      (obj["userMessage"] ?: obj["message"])?.jsonPrimitive?.contentOrNull
    } catch (e: Exception) {
      null
    }
  }

  private companion object {
    const val TAG = "ReceiptSender"
    val JSON = Json { ignoreUnknownKeys = true }
  }
}
