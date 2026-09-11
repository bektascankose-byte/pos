package com.snappos.sync

import com.snappos.data.dao.ConfigDao
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.Response
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Sends every request to whatever server the register is currently configured
 * against.
 *
 * Retrofit fixes its base URL at construction, and the dependency graph is
 * built before the device has been configured — so reading the URL once
 * resolved to a placeholder and pinned every request to the wrong host for the
 * life of the process. Rewriting per request fixes that, and has the useful
 * side effect that a register can be pointed at a different server without
 * restarting.
 *
 * Only scheme, host and port are replaced. The path stays as the API interface
 * declared it, so a typo in a stored URL cannot silently redirect an endpoint
 * somewhere else.
 */
@Singleton
class BaseUrlInterceptor @Inject constructor(private val config: ConfigDao) : Interceptor {

  override fun intercept(chain: Interceptor.Chain): Response {
    val configured = runBlocking { config.get()?.apiBaseUrl }?.toHttpUrlOrNull()
      ?: return chain.proceed(chain.request())

    val request = chain.request()
    val rewritten = request.url.newBuilder()
      .scheme(configured.scheme)
      .host(configured.host)
      .port(configured.port)
      .build()

    return chain.proceed(request.newBuilder().url(rewritten).build())
  }

  companion object {
    /** Never contacted. Retrofit only requires that it parse. */
    const val PLACEHOLDER = "http://register.invalid/"
  }
}
