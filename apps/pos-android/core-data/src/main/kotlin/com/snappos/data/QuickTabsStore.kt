package com.snappos.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Where a cashier's quick tabs point.
 *
 * A destination rather than a product list, so a tab keeps working when the
 * shop stocks a new flavour: "Foger / SwitchPro Disposable Pod" gains the new
 * one by itself, where a saved list of forty-eight ids would silently go stale
 * the day a forty-ninth arrived.
 */
enum class QuickTabKind { Everything, Category, Brand, Line }

data class QuickTab(
  val kind: QuickTabKind,
  /** Category id, brand name or line id. Null for [QuickTabKind.Everything]. */
  val target: String?,
  val label: String,
)

/**
 * Each cashier's own front page.
 *
 * Per cashier and not per register, which is the whole point. Two people work
 * the same till and reach for different things: one sells vapes all evening and
 * one runs the lottery and the coffee, and a single shared front page makes one
 * of them wrong all shift. The register knows who unlocked it, so it can simply
 * show each of them their own.
 *
 * Kept in preferences rather than in the database because it is neither a
 * projection of the server nor a fact about money -- it is this person's
 * habits on this device. Losing it costs a minute of re-pinning and nothing
 * else, and it must never appear in an outbox.
 */
@Singleton
class QuickTabsStore @Inject constructor(
  @ApplicationContext private val context: Context,
) {

  fun observe(employeeId: String?): Flow<List<QuickTab>> =
    context.quickTabs.data.map { prefs ->
      employeeId?.let { prefs[key(it)] }?.let(::decode) ?: emptyList()
    }

  suspend fun toggle(employeeId: String, tab: QuickTab) {
    val current = observe(employeeId).first()
    val without = current.filterNot { it.kind == tab.kind && it.target == tab.target }
    val next = if (without.size == current.size) current + tab else without
    context.quickTabs.edit { it[key(employeeId)] = encode(next.take(MAX_TABS)) }
  }

  suspend fun isPinned(employeeId: String?, kind: QuickTabKind, target: String?): Boolean =
    employeeId != null && observe(employeeId).first().any { it.kind == kind && it.target == target }

  private fun key(employeeId: String) = stringPreferencesKey("quick_tabs_$employeeId")

  // A record per line, fields separated by a unit separator. Chosen over JSON
  // because a label is free text a manager types and a delimiter that cannot
  // occur in typed text needs no escaping and therefore cannot be got wrong.
  private fun encode(tabs: List<QuickTab>): String =
    tabs.joinToString("\n") { "${it.kind.name}\u001F${it.target.orEmpty()}\u001F${it.label}" }

  private fun decode(raw: String): List<QuickTab> =
    raw.lineSequence().filter { it.isNotBlank() }.mapNotNull { line ->
      val f = line.split('\u001F')
      if (f.size < 3) return@mapNotNull null
      val kind = QuickTabKind.entries.firstOrNull { it.name == f[0] } ?: return@mapNotNull null
      QuickTab(kind, f[1].takeIf { it.isNotEmpty() }, f[2])
    }.toList()

  private companion object {
    /**
     * A row of tabs a cashier can hit without reading the labels.
     *
     * Past about a dozen the row stops being a shortcut and becomes a second
     * menu to search, which is the thing it exists to replace.
     */
    const val MAX_TABS = 12
  }
}

private val Context.quickTabs by preferencesDataStore("snappos_quick_tabs")
