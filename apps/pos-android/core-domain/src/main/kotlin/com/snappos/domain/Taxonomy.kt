package com.snappos.domain

/**
 * Brand, model line and flavour, worked out from product names.
 *
 * A vape shop's catalog arrives as one flat string per item and nothing else:
 *
 *     FOGER SwitchPro Disposable Pod Blue Razz Ice
 *     FOGER SwitchPro Disposable Pod Frozen Watermelon
 *     ... forty-six more, all beginning with the same twenty-nine characters
 *
 * The three words that tell them apart are at the end, which is the part a
 * tile cuts off, so the grid reads "FOGER SwitchPro Di..." forty-eight times
 * over. The structure a cashier actually navigates -- brand, then model, then
 * flavour -- is in that string, and nowhere else. No supplier feed carries it
 * and nobody is going to retype fifty products by hand.
 *
 * So it is derived. Three shapes appear in real data and all three are handled:
 *
 *   1. `productName` + `variantName`  -- "Geek Bar Pulse X" / "Miami Mint".
 *      Already structured. Believed as given.
 *   2. A pipe in the name -- "Geek Bar CLR | Amazon Lemonade". Someone already
 *      drew the line; split on it.
 *   3. Flavour welded onto the name, with no separator. This is the Foger case
 *      and the only one that needs inference.
 *
 * Inference is deliberately conservative. Getting it wrong is not cosmetic:
 * the same split names the line on the customer's receipt. When the shape of a
 * brand's names is not clearly a model-plus-flavour, this gives up and returns
 * the name unchanged rather than inventing a split.
 */
data class ProductNameParts(
  /** As the catalog spells it: "Foger", not "FOGER". */
  val brand: String?,
  /** The model, with the brand taken off the front: "SwitchPro Disposable Pod". */
  val line: String?,
  /** What distinguishes this item within its line: "Mexico Mango". */
  val flavour: String?,
  /** The untouched name, returned whenever nothing better could be established. */
  val fullName: String,
) {

  /**
   * What goes on a cart row and on the receipt.
   *
   * "Foger SwitchPro Disposable Pod | Mexico Mango". The pipe is load bearing:
   * a customer checking a receipt scans for the flavour, and a space would
   * leave it buried in the middle of six words that are identical on every
   * other line.
   */
  val label: String
    get() {
      val head = listOfNotNull(brand?.takeIf { it.isNotBlank() }, line?.takeIf { it.isNotBlank() })
        .joinToString(" ")
      return when {
        head.isBlank() -> fullName
        flavour.isNullOrBlank() -> head
        else -> "$head | $flavour"
      }
    }

  /**
   * What goes on a tile, which is already inside its own model line.
   *
   * The brand is the tab the cashier is standing in and the model is the
   * submenu they just tapped, so repeating either on every tile spends the
   * space that the one distinguishing word needs.
   */
  val tileLabel: String get() = flavour?.takeIf { it.isNotBlank() } ?: line?.takeIf { it.isNotBlank() } ?: fullName
}

/** What the taxonomy needs to know about one sellable item. */
data class NamedItem(
  val id: String,
  val productName: String,
  val variantName: String?,
  val brandName: String?,
)

/**
 * Split a whole catalog at once.
 *
 * Whole catalog, not one item at a time, because a model line can only be
 * recognised by what it has in common with its neighbours. A single name in
 * isolation carries no signal at all: "FOGER SwitchPro Disposable Pod Blue
 * Razz Ice" could be a four word model with a two word flavour or the reverse,
 * and only the other forty-seven names say which.
 */
fun taxonomize(items: List<NamedItem>): Map<String, ProductNameParts> {
  val out = HashMap<String, ProductNameParts>(items.size)

  for ((brand, group) in items.groupBy { it.brandName?.trim()?.takeIf { b -> b.isNotEmpty() } }) {
    // Items that already say where the split goes are taken at their word, and
    // kept out of the inference below -- they would otherwise drag the shared
    // prefix of the whole brand down to nothing.
    val explicit = ArrayList<Pair<NamedItem, Pair<String, String?>>>()
    val inferred = ArrayList<NamedItem>()

    for (item in group) {
      val variant = item.variantName?.trim()?.takeIf { it.isNotEmpty() }
      val pipe = item.productName.indexOf('|')
      when {
        variant != null -> explicit += item to (item.productName.trim() to variant)
        pipe > 0 -> explicit += item to (
          item.productName.take(pipe).trim() to item.productName.drop(pipe + 1).trim().ifEmpty { null }
          )
        else -> inferred += item
      }
    }

    for ((item, split) in explicit) {
      out[item.id] = ProductNameParts(
        brand = brand,
        line = stripBrand(split.first, brand),
        flavour = split.second,
        fullName = item.productName,
      )
    }

    for ((item, prefix) in inferModelLines(inferred.map { it.productName }).let { prefixes ->
      inferred.map { it to prefixes[it.productName] }
    }) {
      val stem = prefix?.takeIf { it.isNotBlank() }
      val flavour = stem?.let { item.productName.trim().drop(it.length).trim().ifEmpty { null } }
      out[item.id] = ProductNameParts(
        brand = brand,
        line = stem?.let { stripBrand(it, brand) },
        flavour = flavour,
        fullName = item.productName,
      )
    }
  }
  return out
}

/**
 * Drop the brand from the front of a model line.
 *
 * Whole leading words only, so "Backwoods Cigars 5pk" for brand "Backwoods"
 * becomes "Cigars 5pk" -- which is what the shelf calls it -- while a brand
 * that is genuinely part of the model keeps reading correctly. A name that is
 * nothing but its brand keeps the brand rather than becoming empty.
 */
private fun stripBrand(line: String, brand: String?): String {
  if (brand.isNullOrBlank()) return line.trim()
  val lineWords = line.trim().split(' ').filter { it.isNotEmpty() }
  val brandWords = brand.trim().split(' ').filter { it.isNotEmpty() }
  if (lineWords.size <= brandWords.size) return line.trim()
  for (i in brandWords.indices) {
    if (!lineWords[i].equals(brandWords[i], ignoreCase = true)) return line.trim()
  }
  return lineWords.drop(brandWords.size).joinToString(" ")
}

/**
 * The largest number of models one brand is assumed to split into.
 *
 * This is the whole inference, and it rests on one observation about how these
 * names are built: a brand fans out into a handful of models, and a model fans
 * out into a great many flavours. Foger sells four or five lines; the SwitchPro
 * pod alone comes in forty-eight flavours. So a branch point with three
 * children is a model boundary and one with thirty is a flavour boundary, and
 * the threshold between them only has to land somewhere in that gap.
 */
private const val MAX_MODELS_PER_BRAND = 6

/**
 * Below this many products, a brand is left as one group.
 *
 * Splitting three products into three groups of one buys the cashier nothing
 * and costs them a tap.
 */
private const val MIN_PRODUCTS_TO_SPLIT = 4

private class Node {
  val children = LinkedHashMap<String, Node>()
  /** The first spelling seen for this token, so display keeps the catalog's casing. */
  var display: String = ""
  var terminal = false
  var leaves = 0
}

/**
 * Work out, for each name, how much of its front is the model line.
 *
 * Builds a word trie over one brand's names and walks down it. A run of
 * single-child nodes is shared by everything below and is therefore part of
 * the model. At a branch the question is whether the split is between models
 * or between flavours, answered by two tests:
 *
 *   - **A narrow branch is a model split.** More than [MAX_MODELS_PER_BRAND]
 *     ways is a flavour list, not a product range.
 *   - **Every branch must itself contain more than one product.** This is what
 *     stops a small line being shredded. Six pod flavours -- Blue Razz, Blue
 *     Dragon, Cherry Bomb, Cool Mint, Mango, Peach -- branch five ways, which
 *     passes the first test, and four of those five branches hold exactly one
 *     product. Real model lines do not look like that; a flavour list does.
 *
 * Returns name to model-line prefix. A name maps to an empty prefix when no
 * structure could be established, and the caller leaves it alone.
 */
private fun inferModelLines(names: List<String>): Map<String, String> {
  if (names.isEmpty()) return emptyMap()

  val root = Node()
  for (name in names) {
    var node = root
    node.leaves++
    for (word in name.trim().split(' ').filter { it.isNotEmpty() }) {
      node = node.children.getOrPut(word.lowercase()) { Node().also { it.display = word } }
      node.leaves++
    }
    node.terminal = true
  }

  val prefixes = ArrayList<List<String>>()
  fun cut(node: Node, path: List<String>) {
    var current = node
    var here = path
    // A run of words every name below shares is part of the model by definition.
    while (current.children.size == 1 && !current.terminal) {
      val only = current.children.values.first()
      here = here + only.display
      current = only
    }
    val splittable = !current.terminal &&
      current.leaves >= MIN_PRODUCTS_TO_SPLIT &&
      current.children.size in 2..MAX_MODELS_PER_BRAND &&
      current.children.values.all { it.leaves >= 2 }
    if (splittable) {
      for (child in current.children.values) cut(child, here + child.display)
    } else {
      prefixes += here
    }
  }
  cut(root, emptyList())

  // Longest first, so a name under "Foger SwitchPro Kit" is not claimed by the
  // shorter "Foger SwitchPro" when both are live groups.
  val ordered = prefixes.sortedByDescending { it.size }
  val out = HashMap<String, String>(names.size)
  for (name in names) {
    val words = name.trim().split(' ').filter { it.isNotEmpty() }
    val match = ordered.firstOrNull { prefix ->
      prefix.size <= words.size &&
        prefix.indices.all { words[it].equals(prefix[it], ignoreCase = true) }
    }
    out[name] = match?.joinToString(" ").orEmpty()
  }
  return out
}
