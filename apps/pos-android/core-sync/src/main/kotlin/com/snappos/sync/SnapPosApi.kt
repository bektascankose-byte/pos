package com.snappos.sync

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Query

/**
 * The server, as the register sees it.
 *
 * Deliberately small. A register talks to four endpoints: sign in, refresh,
 * pull a catalog, push what it sold. Everything else a POS does happens on the
 * device, which is the whole point.
 */
interface SnapPosApi {

  @POST("api/v1/auth/login")
  suspend fun login(@Body body: LoginRequest): Response<TokenPair>

  @POST("api/v1/auth/refresh")
  suspend fun refresh(@Body body: RefreshRequest): Response<TokenPair>

  /** Bootstrap. Everything this store sells, in one response. */
  @GET("api/v1/sync/catalog")
  suspend fun catalog(@Query("store_id") storeId: String): Response<CatalogSnapshot>

  /**
   * Upload. Ordered but not atomic on the server: entity 7 failing does not
   * block entities 1 to 6, and each comes back with its own verdict.
   */
  @POST("api/v1/sync/batch")
  suspend fun upload(@Body body: SyncBatchRequest): Response<SyncBatchResponse>

  /** Who am I and what may I do. Called right after sign in. */
  @GET("api/v1/auth/session")
  suspend fun session(): Response<SessionDto>

  @GET("api/v1/stores")
  suspend fun stores(): Response<DataEnvelope<StoreDto>>

  @GET("api/v1/registers")
  suspend fun registers(): Response<DataEnvelope<RegisterDto>>
}

@Serializable
data class LoginRequest(val email: String, val password: String, val device_id: String? = null)

@Serializable
data class RefreshRequest(val refresh_token: String)

@Serializable
data class TokenPair(
  val access_token: String,
  val expires_in: Int,
  val refresh_token: String,
)

@Serializable
data class DataEnvelope<T>(val data: List<T>)

@Serializable
data class SessionDto(
  val user_id: String,
  val org_id: String,
  val store_id: String? = null,
  val register_id: String? = null,
  val permissions: List<String> = emptyList(),
)

@Serializable
data class StoreDto(
  val id: String,
  val code: String,
  val name: String,
  val timezone: String? = null,
)

@Serializable
data class RegisterDto(
  val id: String,
  val store_id: String,
  val code: String,
  val name: String,
  /**
   * The highest receipt sequence this register has used, as the server knows
   * it. A re-provisioned device resumes from here rather than restarting at 1
   * and colliding with receipt numbers that already exist.
   */
  val last_sequence: String = "0",
)

// ------------------------------------------------------------------- upload

/**
 * One entity in a batch.
 *
 * `id` is the entity's own UUIDv7 and doubles as its idempotency key. There is
 * no separate key to get wrong, and no way to submit one sale under two
 * identities — which is what makes an aggressive retry safe.
 */
@Serializable
data class SyncEnvelope(
  val id: String,
  val entity_type: String,
  val device_time: String,
  val attempt: Int = 0,
  val payload: JsonObject,
)

@Serializable
data class SyncBatchRequest(
  val register_id: String,
  val device_id: String,
  val entities: List<SyncEnvelope>,
)

@Serializable
data class SyncResult(
  val id: String,
  /** accepted, duplicate or rejected. **duplicate is a success.** */
  val status: String,
  val error: SyncError? = null,
)

@Serializable
data class SyncError(val code: String, val message: String, val retryable: Boolean)

@Serializable
data class SyncBatchResponse(
  val results: List<SyncResult>,
  val server_time: String,
  /**
   * Measured drift between this device's clock and the server's. Stored on the
   * device record; reports always use server time, so a register with a wrong
   * clock cannot reorder the day's sales.
   */
  val clock_offset_ms: Long,
)

// ----------------------------------------------------------------- catalog

@Serializable
data class CatalogSnapshot(
  val categories: List<CategoryDto>,
  val variants: List<VariantDto>,
  val barcodes: List<BarcodeDto>,
  val prices: List<PriceDto>,
  val inventory: List<InventoryDto>,
  val tax_rates: List<TaxRateDto>,
  val employees: List<EmployeeDto> = emptyList(),
  val cursor: String,
  val server_time: String,
)

@Serializable
data class CategoryDto(
  val id: String,
  val parent_id: String? = null,
  val slug: String,
  val name: String,
  val path: String,
  val depth: Int,
  val sort_order: Int,
  val tile_color: String? = null,
  val is_department: Boolean,
)

@Serializable
data class VariantDto(
  val id: String,
  val product_id: String,
  val product_name: String,
  val variant_name: String? = null,
  val sku: String,
  val plu: String? = null,
  val brand_id: String? = null,
  val brand_name: String? = null,
  val category_id: String? = null,
  val tax_category_id: String? = null,
  val cost: String,
  val case_quantity: Int,
  val sort_order: Int,
  val is_default: Boolean,
  val status: String,
  val minimum_age: Int? = null,
  val id_scan_required: Boolean = false,
  val regulated_class: String? = null,
)

@Serializable
data class BarcodeDto(
  val id: String,
  val variant_id: String,
  val barcode: String,
  val kind: String,
  val units: String,
  val is_primary: Boolean,
)

@Serializable
data class PriceDto(
  val id: String,
  val variant_id: String,
  val kind: String,
  val price_minor: String,
  val effective_from: String,
  val effective_to: String? = null,
)

@Serializable
data class InventoryDto(
  val variant_id: String,
  val on_hand: String,
  val available: String,
  val updated_at: String,
)

/**
 * An employee who may unlock this register.
 *
 * Carries the Argon2id PIN hash so unlock works offline, and deliberately not
 * the password hash: a password opens the dashboard and everything in it, and a
 * stolen terminal must not be able to carry one.
 */
@Serializable
data class EmployeeDto(
  val id: String,
  val display_name: String,
  val employee_code: String? = null,
  val pin_hash: String,
  val status: String,
  val permissions: List<String> = emptyList(),
)

@Serializable
data class TaxRateDto(
  val tax_category_id: String,
  val rate: String,
  val name: String,
)

/** The API's one error shape, so a failure can be reported rather than guessed at. */
@Serializable
data class ApiErrorBody(
  val code: String,
  val message: String,
  @SerialName("user_message") val userMessage: String? = null,
  @SerialName("request_id") val requestId: String? = null,
  val retryable: Boolean = false,
  val issues: List<JsonElement>? = null,
)
