package com.snappos.sync.di

import android.content.Context
import com.jakewharton.retrofit2.converter.kotlinx.serialization.asConverterFactory
import com.snappos.data.dao.ConfigDao
import com.snappos.sync.AuthInterceptor
import com.snappos.sync.AuthStore
import com.snappos.sync.BaseUrlInterceptor
import com.snappos.sync.SnapPosApi
import dagger.Lazy
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import retrofit2.Retrofit
import java.util.concurrent.TimeUnit
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object SyncModule {

  @Provides
  @Singleton
  fun json(): Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
  }

  @Provides
  @Singleton
  fun authStore(@ApplicationContext context: Context): AuthStore = AuthStore(context)

  @Provides
  @Singleton
  fun authInterceptor(store: AuthStore, api: Lazy<SnapPosApi>): AuthInterceptor =
    AuthInterceptor(store, api)

  @Provides
  @Singleton
  fun baseUrlInterceptor(config: ConfigDao): BaseUrlInterceptor = BaseUrlInterceptor(config)

  @Provides
  @Singleton
  fun okHttp(auth: AuthInterceptor, baseUrl: BaseUrlInterceptor): OkHttpClient =
    OkHttpClient.Builder()
      // Base URL first: it rewrites the destination, and the auth interceptor
      // should attach a token to the request that will actually be sent.
      .addInterceptor(baseUrl)
      .addInterceptor(auth)
      // Short timeouts on purpose. A register that hangs for thirty seconds on
      // a dead network is worse than one that gives up in ten and tries again
      // later: the sale is already safe on device, so there is nothing to gain
      // by waiting and a cashier's attention to lose.
      .connectTimeout(10, TimeUnit.SECONDS)
      .readTimeout(20, TimeUnit.SECONDS)
      .writeTimeout(20, TimeUnit.SECONDS)
      .retryOnConnectionFailure(true)
      .build()

  /**
   * Retrofit needs a base URL at construction, but the register does not have
   * one yet: this graph is built before the device has been configured, so
   * reading the URL here once resolved to a placeholder and every request went
   * to the wrong host for the life of the process.
   *
   * So the value below is a placeholder that is never contacted.
   * `BaseUrlInterceptor` replaces the scheme, host and port on every request
   * from the register's current configuration, which also means a register can
   * be re-pointed at a different server without restarting the app.
   */
  @Provides
  @Singleton
  fun api(client: OkHttpClient, json: Json): SnapPosApi {
    return Retrofit.Builder()
      .baseUrl(BaseUrlInterceptor.PLACEHOLDER)
      .client(client)
      .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
      .build()
      .create(SnapPosApi::class.java)
  }
}
