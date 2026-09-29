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
 * What a cashier's quick menu entry points at.
 *
 * Two different ideas share the one list, because a cashier reaches for both:
 *
 *   - **A place** -- a category, a brand, a model line. It keeps working when
 *     the shop stocks a new flavour: "Foger / SwitchPro Disposable Pod" gains
 *     the forty-ninth by itself, where a saved list of forty-eight ids would
 *     silently go stale.
 *   - **A product** -- the one thing this person rings up forty times a shift.
 *     Tapping it puts it in the cart from wherever they are standing, which no
 *     place can do: even the right folder is a tap and a search by eye away
 *     from the item.
 *
 * The shop asked for products. Places stay because they were already pinned
 * on this till and cost nothing to keep.
 */
enum class QuickTabKind { Everything, Category, Brand, Line, Product }

data class QuickTab(
  val kind: QuickTabKind,
  /** Category id, brand name, line id or variant id. Null for [QuickTabKind.Everything]. */
  val target: String?,
  /**
   * What it was called when it was pinned. A product row prefers the live
   * name from the catalog tree and falls back to this, so an item that has
   * since left the catalog can still be recognised and removed.
   */
  val label: String,
) {
  /** Identity within one cashier's menu. The label is not part of it: renaming a product must not duplicate its pin. */
  val key: String get() = "${kind.name}:${target.orEmpty()}"
}

/** What a pin or unpin did. */
enum class PinResult { Pinned, Unpinned, Full }

/**
 * The quick menu's rules, apart from where they are stored.
 *
 * Pure so they can be tested on the JVM: the list is the order. Position in
 * the saved list *is* the explicit order the cashier dragged it into, which is
 * why every operation here returns the whole list rather than touching one
 * entry -- a separate numeric order field would be a second truth about the
 * same thing, and the two would eventually disagree.
 */
object QuickMenu {

  /**
   * How many entries one cashier can pin.
   *
   * A column a cashier can hit without reading. Past about a dozen it stops
   * being a shortcut and becomes a second menu to search, which is the thing
   * it exists to replace.
   */
  const val MAX = 12

  /**
   * Pin what is not pinned, unpin what is.
   *
   * New pins go to the bottom, where the cashier can see them arrive and drag
   * them up. A full menu refuses and says so -- it used to take the thirteenth
   * pin and silently drop it, which reads to the person holding the tile
   * exactly like a pin that did not work.
   */
  fun toggle(current: List<QuickTab>, tab: QuickTab): Pair<List<QuickTab>, PinResult> {
    val without = current.filterNot { it.key == tab.key }
    return when {
      without.size != current.size -> without to PinResult.Unpinned
      current.size >= MAX -> current to PinResult.Full
      else -> (current + tab) to PinResult.Pinned
    }
  }

  fun remove(current: List<QuickTab>, key: String): List<QuickTab> = current.filterNot { it.key == key }

  /**
   * Put the menu in the order the cashier dragged it into.
   *
   * `keys` is the order the screen showed when the finger lifted. Anything
   * the screen did not know about -- pinned from elsewhere between the drag
   * starting and ending -- keeps its place at the end rather than vanishing,
   * and keys that no longer exist are ignored.
   */
  fun reorder(current: List<QuickTab>, keys: List<String>): List<QuickTab> {
    val byKey = current.associateBy { it.key }
    val ordered = keys.distinct().mapNotNull { byKey[it] }
    val placed = ordered.map { it.key }.toSet()
    return ordered + current.filterNot { it.key in placed }
  }

  // A record per line, fields separated by a unit separator. Chosen over JSON
  // because a label is free text a manager types and a delimiter that cannot
  // occur in typed text needs no escaping and therefore cannot be got wrong.
  fun encode(tabs: List<QuickTab>): String =
    tabs.joinToString("\n") { "${it.kind.name}\u001F${it.target.orEmpty()}\u001F${it.label}" }

  /** Unknown kinds are skipped, so a build that pins something new never breaks an older one reading it. */
  fun decode(raw: String?): List<QuickTab> =
    raw.orEmpty().lineSequence().filter { it.isNotBlank() }.mapNotNull { line ->
      val f = line.split('\u001F')
      if (f.size < 3) return@mapNotNull null
      val kind = QuickTabKind.entries.firstOrNull { it.name == f[0] } ?: return@mapNotNull null
      QuickTab(kind, f[1].takeIf { it.isNotEmpty() }, f[2])
    }.distinctBy { it.key }.toList()
}

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
 *
 * Every change reads and writes inside one `edit`, so a pin and a drag landing
 * together cannot each start from the same old list and lose the other.
 */
@Singleton
class QuickTabsStore @Inject constructor(
  @ApplicationContext private val context: Context,
) {

  fun observe(employeeId: String?): Flow<List<QuickTab>> =
    context.quickTabs.data.map { prefs ->
      employeeId?.let { QuickMenu.decode(prefs[key(it)]) } ?: emptyList()
    }

  suspend fun toggle(employeeId: String, tab: QuickTab): PinResult {
    var result = PinResult.Full
    change(employeeId) { current ->
      val (next, outcome) = QuickMenu.toggle(current, tab)
      result = outcome
      next
    }
    return result
  }

  suspend fun remove(employeeId: String, key: String) =
    change(employeeId) { QuickMenu.remove(it, key) }

  suspend fun reorder(employeeId: String, keys: List<String>) =
    change(employeeId) { QuickMenu.reorder(it, keys) }

  suspend fun isPinned(employeeId: String?, kind: QuickTabKind, target: String?): Boolean =
    employeeId != null && observe(employeeId).first().any { it.kind == kind && it.target == target }

  private suspend fun change(employeeId: String, transform: (List<QuickTab>) -> List<QuickTab>) {
    context.quickTabs.edit { prefs ->
      val key = key(employeeId)
      prefs[key] = QuickMenu.encode(transform(QuickMenu.decode(prefs[key])))
    }
  }

  private fun key(employeeId: String) = stringPreferencesKey("quick_tabs_$employeeId")
}

private val Context.quickTabs by preferencesDataStore("snappos_quick_tabs")
