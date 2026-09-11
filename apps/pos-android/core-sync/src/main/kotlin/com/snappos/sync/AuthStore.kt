package com.snappos.sync

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.Interceptor
import okhttp3.Response
import javax.inject.Inject
import javax.inject.Singleton

private val Context.authDataStore by preferencesDataStore("snappos_auth")

/**
 * The register's tokens.
 *
 * Not in the encrypted database on purpose. The database holds the catalog and
 * unuploaded sales and is opened once at startup; tokens are read and written
 * on a different rhythm, and keeping them apart means a database migration
 * problem cannot also sign the register out mid shift.
 */
@Singleton
class AuthStore @Inject constructor(private val context: Context) {

  private val accessKey = stringPreferencesKey("access_token")
  private val refreshKey = stringPreferencesKey("refresh_token")

  suspend fun save(access: String, refresh: String) {
    context.authDataStore.edit {
      it[accessKey] = access
      it[refreshKey] = refresh
    }
  }

  suspend fun clear() {
    context.authDataStore.edit { it.clear() }
  }

  suspend fun accessToken(): String? = context.authDataStore.data.first()[accessKey]

  suspend fun refreshToken(): String? = context.authDataStore.data.first()[refreshKey]

  suspend fun isSignedIn(): Boolean = accessToken() != null
}

/**
 * Attaches the access token, and refreshes it once when the server says it has
 * expired.
 *
 * The refresh is guarded by a mutex because a sync burst runs several requests
 * at once: without it, five concurrent 401s would each rotate the refresh
 * token, and since rotation invalidates the previous one, four of them would
 * present a spent token. The server treats a spent refresh token as theft and
 * revokes the whole family — which would sign the register out in the middle of
 * a shift, for no reason but our own concurrency.
 */
@Singleton
class AuthInterceptor @Inject constructor(
  private val store: AuthStore,
  private val apiProvider: dagger.Lazy<SnapPosApi>,
) : Interceptor {

  private val refreshLock = Mutex()

  override fun intercept(chain: Interceptor.Chain): Response {
    val token = runBlocking { store.accessToken() }
    val request = chain.request().newBuilder()
      .apply { token?.let { header("Authorization", "Bearer $it") } }
      .build()

    val response = chain.proceed(request)
    if (response.code != 401 || token == null) return response

    response.close()

    val refreshed = runBlocking {
      refreshLock.withLock {
        // Another request may have refreshed while this one waited. If the
        // stored token changed, use it rather than rotating again.
        val current = store.accessToken()
        if (current != null && current != token) return@withLock current

        val refresh = store.refreshToken() ?: return@withLock null
        val result = runCatching { apiProvider.get().refresh(RefreshRequest(refresh)) }
          .getOrNull()
        val body = result?.body()
        if (result?.isSuccessful == true && body != null) {
          store.save(body.access_token, body.refresh_token)
          body.access_token
        } else {
          // The refresh token is spent, revoked or expired. Clearing means the
          // register asks for a sign in rather than retrying forever against a
          // credential that will never work again.
          store.clear()
          null
        }
      }
    } ?: return chain.proceed(request)

    return chain.proceed(
      chain.request().newBuilder().header("Authorization", "Bearer $refreshed").build(),
    )
  }
}
