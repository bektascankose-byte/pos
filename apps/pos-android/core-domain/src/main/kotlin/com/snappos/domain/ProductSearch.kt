package com.snappos.domain

/**
 * Search the way a cashier types.
 *
 * The register used to search with one `LIKE '%query%'` over each product's
 * text, which asks for the typed characters to appear together, in order,
 * exactly as typed. Nobody at a counter types like that. With a customer
 * pointing at a blue pod they type "fog razz", and the catalog says
 *
 *     FOGER SwitchPro KIt 30K Blue Razz Ice
 *
 * "fog razz" appears nowhere in that string, so the grid came back empty and
 * the cashier went back to walking the folders.
 *
 * So the query is taken apart into words, and **each typed word must be found
 * somewhere in the product on its own**, in any order. A typed word is found
 * when it begins one of the product's words -- "fog" begins "Foger", "switch"
 * begins "SwitchPro" -- and every typed word must be found, so "foger mint"
 * never offers a Geek Bar Miami Mint. That is the whole rule, and it is the one
 * a cashier already expects from their phone's contact search.
 *
 * Three smaller kindnesses sit on top, each for a way this shop's names are
 * actually written:
 *
 *   - **Joined words are split.** "SwitchPro" also answers to "pro", and
 *     "BM6000" to "6000", because a supplier's capitalisation is not a word
 *     boundary a cashier can see.
 *   - **Split words are joined.** "Geek Bar" also answers to "geekbar", which is
 *     how it gets typed in a hurry.
 *   - **The middle of a word still counts, a little.** The old substring search
 *     found "Strawberry" for "berry" and the last digits of a barcode for
 *     "4056", and taking that away would be a regression somebody discovers at
 *     the counter. It is kept for words of three letters or more, and ranked
 *     below every whole-word and start-of-word match, so it can only ever add
 *     results under the ones the cashier meant.
 *   - **One slip is forgiven, as a last resort.** A word of four letters or
 *     more that matches nothing any other way may still match a product word
 *     one keystroke away -- one letter wrong, missing, extra, or two swapped.
 *     This is for voice as much as for thumbs: a speech recogniser has never
 *     heard of Foger and writes "fogger", which is one letter out. It ranks
 *     below everything else, so it only decides anything when nothing better
 *     was found.
 *
 * Ranking is the sum over typed words of how well each one landed -- the whole
 * word, the start of a word, or somewhere inside one -- and ties keep the order
 * of the catalog's own menu, so results arrive grouped by brand and model line
 * the way the folders are, rather than shuffled.
 *
 * Pure and in memory. The shop has hundreds of products, not millions; scoring
 * every one of them on every keystroke costs well under a millisecond on the
 * till and needs no index to keep in step with the catalog.
 */
class ProductSearchIndex(private val documents: List<SearchDocument>) {

  val isEmpty: Boolean get() = documents.isEmpty()

  /** Ids of the matching products, best first. Blank or wordless queries match nothing. */
  fun search(query: String, limit: Int = Int.MAX_VALUE): List<String> {
    val tokens = queryTokens(query)
    if (tokens.isEmpty()) return emptyList()

    val hits = ArrayList<Hit>()
    documents.forEachIndexed { position, doc ->
      var total = 0
      for (token in tokens) {
        val score = doc.score(token)
        // Every typed word has to land. One miss and the product is out.
        if (score == MISS) return@forEachIndexed
        total += score
      }
      hits += Hit(position, total)
    }
    return hits
      .sortedWith(compareByDescending<Hit> { it.score }.thenBy { it.position })
      .take(limit)
      .map { documents[it.position].id }
  }

  private class Hit(val position: Int, val score: Int)

  companion object {
    val EMPTY = ProductSearchIndex(emptyList())
  }
}

/**
 * One product, reduced to the words a cashier might type for it.
 *
 * Built once per catalog change rather than per keystroke, so the splitting
 * and joining below is paid for when a sync lands and never while somebody is
 * typing.
 */
class SearchDocument private constructor(val id: String, private val words: List<String>) {

  private val exact: Set<String> = words.toHashSet()

  internal fun score(token: String): Int {
    if (token in exact) return EXACT
    var best = MISS
    for (word in words) {
      // Nothing left to beat once a word starts with the token.
      if (word.startsWith(token)) return PREFIX
      if (best < INFIX && token.length >= MIN_INFIX && word.contains(token)) best = INFIX
      if (best < NEAR && token.length >= MIN_NEAR && word.length >= MIN_NEAR && withinOneEdit(token, word)) {
        best = NEAR
      }
    }
    return best
  }

  companion object {
    /**
     * Everything that names one product: the taxonomy's brand, line and
     * flavour, the raw catalog name, SKU, PLU and barcodes. Nulls and blanks
     * are skipped, so callers can pass whatever they have.
     */
    fun of(id: String, vararg texts: String?): SearchDocument {
      val words = LinkedHashSet<String>()
      for (text in texts) if (!text.isNullOrBlank()) indexWords(text, words)
      return SearchDocument(id, words.toList())
    }
  }
}

/** How a typed word landed on a product. Higher is better; [MISS] disqualifies. */
private const val MISS = 0
private const val NEAR = 1
private const val INFIX = 2
private const val PREFIX = 4
private const val EXACT = 6

/**
 * The shortest typed word allowed to match inside another word.
 *
 * Two letters inside a word match nearly everything -- "ce" is in "Ice",
 * "Juice", "Device" -- which would bury real results under noise. Three is
 * where it starts to mean something.
 */
private const val MIN_INFIX = 3

/**
 * The shortest word allowed to match with a slip in it.
 *
 * Below four letters, one edit away from a word is most words: "ice" is one
 * letter from "icy", "ace", "ire" and "mice". At four it is still a real hint.
 */
private const val MIN_NEAR = 4

/**
 * Whether two words differ by at most one keystroke: a letter changed, added
 * or dropped, or two neighbouring letters swapped.
 *
 * Linear, not a full edit-distance table, because the only question ever
 * asked is "one or fewer", and it is asked for every word of every product on
 * every keystroke.
 */
internal fun withinOneEdit(a: String, b: String): Boolean {
  if (a == b) return true
  val la = a.length
  val lb = b.length
  if (la - lb > 1 || lb - la > 1) return false
  var i = 0
  while (i < la && i < lb && a[i] == b[i]) i++
  return when {
    la == lb ->
      a.regionMatches(i + 1, b, i + 1, la - i - 1) ||
        (i + 1 < la && a[i] == b[i + 1] && a[i + 1] == b[i] && a.regionMatches(i + 2, b, i + 2, la - i - 2))
    la > lb -> a.regionMatches(i + 1, b, i, lb - i)
    else -> a.regionMatches(i, b, i + 1, la - i)
  }
}

/** The words of a query: lowercased, deduplicated, punctuation dropped. */
internal fun queryTokens(query: String): List<String> =
  splitWords(query).map { it.lowercase() }.distinct()

/**
 * The words of a product, with the joined and split forms described on
 * [ProductSearchIndex].
 */
private fun indexWords(text: String, into: MutableCollection<String>) {
  val words = splitWords(text)
  for ((i, word) in words.withIndex()) {
    into += word.lowercase()
    val pieces = casePieces(word)
    if (pieces.size > 1) pieces.forEach { into += it.lowercase() }
    words.getOrNull(i + 1)?.let { next -> into += (word + next).lowercase() }
  }
}

/**
 * Split on anything that is not a letter or a digit.
 *
 * Apostrophes are dropped rather than split on, so "Hershey's" stays one word
 * and answers to "hersheys", which is how it gets typed.
 */
private fun splitWords(text: String): List<String> {
  val out = ArrayList<String>()
  val current = StringBuilder()
  for (c in text) {
    when {
      c == '\'' || c == '’' -> Unit
      c.isLetterOrDigit() -> current.append(c)
      current.isNotEmpty() -> {
        out += current.toString()
        current.setLength(0)
      }
    }
  }
  if (current.isNotEmpty()) out += current.toString()
  return out
}

/**
 * Where a supplier ran two words together: a lower-case letter followed by a
 * capital ("SwitchPro"), or a change between letters and digits ("BM6000",
 * "30K"). "KIt" and "NEXT" are left whole -- a run of capitals is shouting, not
 * a boundary.
 */
private fun casePieces(word: String): List<String> {
  val out = ArrayList<String>()
  var start = 0
  for (i in 1 until word.length) {
    val a = word[i - 1]
    val b = word[i]
    val boundary = (a.isLowerCase() && b.isUpperCase()) ||
      (a.isLetter() && b.isDigit()) ||
      (a.isDigit() && b.isLetter())
    if (boundary) {
      out += word.substring(start, i)
      start = i
    }
  }
  out += word.substring(start)
  return out
}
