package com.snappos.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import javax.inject.Inject
import javax.inject.Singleton

/** A brand as the till's folders need it: its name, and the picture on its folder. */
@Serializable
data class BrandInfo(
  val id: String,
  val name: String,
  /** Server-relative path to the brand's logo, or null when it has none. */
  val logoUrl: String? = null,
)

private val Context.brandStore by preferencesDataStore("snappos_brands")

/**
 * The brands the server last sent, with their logos.
 *
 * In preferences rather than the encrypted database, the way the quick menu
 * is: a logo is how a folder looks, nothing is priced or sold from it, and
 * keeping it out of the database that holds unsent sales meant adding it
 * needed no migration of that database. Losing it costs one sync.
 */
@Singleton
class BrandStore @Inject constructor(
  @ApplicationContext private val context: Context,
) {
  private val key = stringPreferencesKey("brands")
  private val json = Json { ignoreUnknownKeys = true }
  private val serializer = ListSerializer(BrandInfo.serializer())

  fun observe(): Flow<List<BrandInfo>> =
    context.brandStore.data.map { prefs ->
      prefs[key]?.let { runCatching { json.decodeFromString(serializer, it) }.getOrNull() }.orEmpty()
    }

  /** Replaces the whole list: what the server sent is the list. */
  suspend fun replace(brands: List<BrandInfo>) {
    context.brandStore.edit { it[key] = json.encodeToString(serializer, brands) }
  }
}
