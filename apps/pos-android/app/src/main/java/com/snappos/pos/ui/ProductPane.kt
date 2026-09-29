package com.snappos.pos.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.SearchOff
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.snappos.data.BrandNode
import com.snappos.data.LineNode
import com.snappos.data.ResolvedProduct
import com.snappos.domain.ProductNameParts
import com.snappos.pos.productImageUrlLarge

/**
 * A row of chips that appears and disappears with its contents.
 *
 * The brand row and the model row are the same component twice. Both slide open
 * rather than blinking in, because the rows below them move when they do and a
 * grid that jumps under a finger already reaching for it is how a cashier rings
 * up the wrong thing.
 */
@Composable
fun ChipRow(
  visible: Boolean,
  modifier: Modifier = Modifier,
  content: @Composable () -> Unit,
) {
  AnimatedVisibility(
    visible = visible,
    enter = fadeIn(tween(Motion.NORMAL)) + expandVertically(tween(Motion.NORMAL, easing = Motion.EaseOut)),
    exit = fadeOut(tween(Motion.FAST)) + shrinkVertically(tween(Motion.FAST, easing = Motion.Ease)),
    modifier = modifier,
  ) { content() }
}

@Composable
fun BrandChips(
  brands: List<BrandNode>,
  selectedId: String?,
  onSelect: (String?) -> Unit,
) {
  LazyRow(
    Modifier.fillMaxWidth().padding(horizontal = Space.M.dp, vertical = Space.XS.dp),
    horizontalArrangement = Arrangement.spacedBy(Space.S.dp),
  ) {
    items(brands, key = { it.id }) { brand ->
      NavChip(
        label = brand.name,
        count = brand.itemCount,
        selected = brand.id == selectedId,
        onClick = { onSelect(brand.id) },
      )
    }
  }
}

@Composable
fun LineChips(
  lines: List<LineNode>,
  selectedId: String?,
  onSelect: (String?) -> Unit,
) {
  LazyRow(
    Modifier.fillMaxWidth().padding(horizontal = Space.M.dp, vertical = Space.XS.dp),
    horizontalArrangement = Arrangement.spacedBy(Space.S.dp),
  ) {
    items(lines, key = { it.id }) { line ->
      NavChip(
        label = line.name,
        count = line.variantIds.size,
        selected = line.id == selectedId,
        secondary = true,
        onClick = { onSelect(line.id) },
      )
    }
  }
}

/**
 * One chip.
 *
 * Carries its own count. A cashier deciding whether to tap "SwitchPro
 * Disposable Pod" is helped by knowing it holds forty-eight things and "Battery"
 * holds two, and the number costs nothing to show.
 */
@Composable
private fun NavChip(
  label: String,
  count: Int,
  selected: Boolean,
  secondary: Boolean = false,
  onClick: () -> Unit,
) {
  val background by animateColorAsState(
    when {
      selected && !secondary -> BrandOrange.copy(alpha = 0.14f)
      selected -> BrandRed.copy(alpha = 0.10f)
      else -> MaterialTheme.colorScheme.surfaceVariant
    },
    tween(Motion.NORMAL, easing = Motion.Ease),
    label = "chip-bg",
  )
  val border by animateColorAsState(
    if (selected) BrandOrange.copy(alpha = 0.55f) else Color.Transparent,
    tween(Motion.NORMAL, easing = Motion.Ease),
    label = "chip-border",
  )

  Row(
    Modifier
      .height(if (secondary) 42.dp else 46.dp)
      .clip(RoundedCornerShape(Corner.CHIP.dp))
      .background(background)
      .border(1.dp, border, RoundedCornerShape(Corner.CHIP.dp))
      .clickable(onClick = onClick)
      .padding(horizontal = Space.M.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(
      label,
      style = if (secondary) MaterialTheme.typography.bodyMedium else MaterialTheme.typography.bodyLarge,
      fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium,
      color = if (selected) BrandRed else MaterialTheme.colorScheme.onSurface,
      maxLines = 1,
    )
    Spacer(Modifier.width(Space.S.dp))
    Text(
      count.toString(),
      style = MaterialTheme.typography.labelMedium,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
  }
}

/**
 * The grid.
 *
 * Sized so the photograph is the thing you see and the words are the caption,
 * which is the inversion this screen needed. A cashier reaching for a Blue Razz
 * pod recognises the packet from a metre away and cannot read "SwitchPro
 * Disposable Pod Blue Razz Ice" at all until they are leaning over the counter.
 */
@Composable
fun ProductGrid(
  tiles: List<ResolvedProduct>,
  parts: Map<String, ProductNameParts>,
  /** True when the grid is already inside one model line, so the tiles need no brand line. */
  insideLine: Boolean,
  onTap: (ResolvedProduct) -> Unit,
  modifier: Modifier = Modifier,
  tileWidth: Dp = Touch.TILE.dp,
) {
  if (tiles.isEmpty()) {
    EmptyGrid(modifier)
    return
  }
  LazyVerticalGrid(
    columns = GridCells.Adaptive(minSize = tileWidth),
    modifier = modifier.padding(horizontal = Space.M.dp),
    horizontalArrangement = Arrangement.spacedBy(Space.S.dp),
    verticalArrangement = Arrangement.spacedBy(Space.S.dp),
    contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = Space.M.dp),
  ) {
    items(tiles, key = { it.variantId }) { tile ->
      ProductTileCard(
        tile = tile,
        parts = parts[tile.variantId],
        insideLine = insideLine,
        onTap = { onTap(tile) },
      )
    }
  }
}

@Composable
private fun ProductTileCard(
  tile: ResolvedProduct,
  parts: ProductNameParts?,
  insideLine: Boolean,
  onTap: () -> Unit,
) {
  // Inside a model line every tile shares the brand and the model, so showing
  // them again spends the tile on words that do not tell two tiles apart.
  val heading = if (insideLine) null else {
    listOfNotNull(parts?.brand, parts?.line).joinToString(" ").takeIf { it.isNotBlank() }
  }
  val name = parts?.tileLabel ?: tile.tileLabel

  Column(
    Modifier
      .clip(RoundedCornerShape(Corner.CARD.dp))
      .background(MaterialTheme.colorScheme.surface)
      .border(1.dp, MaterialTheme.colorScheme.outline, RoundedCornerShape(Corner.CARD.dp))
      .clickable(onClick = onTap)
      .padding(Space.S.dp),
  ) {
    Box(
      Modifier
        .fillMaxWidth()
        .aspectRatio(1.15f)
        .clip(RoundedCornerShape(Corner.CHIP.dp))
        .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f)),
      contentAlignment = Alignment.Center,
    ) {
      if (tile.imageUrl != null) {
        AsyncImage(
          model = productImageUrlLarge(tile.imageUrl!!),
          contentDescription = null,
          contentScale = ContentScale.Fit,
          modifier = Modifier.fillMaxSize().padding(Space.XS.dp),
        )
      } else {
        // A monogram rather than an empty box. Most of a real shop's catalog
        // has no photograph, and a grid of identical grey rectangles gives the
        // eye nothing at all to aim at -- a letter at least differs.
        Text(
          name.take(1).uppercase(),
          style = MaterialTheme.typography.displaySmall,
          color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.35f),
        )
      }
      if (!tile.inStock) {
        // Neutral, not red, and in the corner of the photo rather than beside
        // the price -- a red "OUT" against "$19.99" read as part of the number.
        Text(
          "OUT",
          style = MaterialTheme.typography.labelSmall,
          color = Color.White,
          modifier = Modifier
            .align(Alignment.TopEnd)
            .padding(Space.XS.dp)
            .clip(RoundedCornerShape(999.dp))
            .background(MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.85f))
            .padding(horizontal = Space.S.dp, vertical = 2.dp),
        )
      }
    }

    Spacer(Modifier.height(Space.S.dp))
    heading?.let {
      Text(
        it.uppercase(),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
    }
    Text(
      name,
      style = MaterialTheme.typography.titleMedium,
      maxLines = 2,
      overflow = TextOverflow.Ellipsis,
      modifier = Modifier.height(if (heading == null) 44.dp else 40.dp),
    )
    Text(
      tile.price?.let { "$${it.toMajorString()}" } ?: "No price",
      style = MaterialTheme.typography.titleLarge.merge(MoneyTextStyle),
      color = if (tile.price == null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
    )
  }
}

@Composable
private fun EmptyGrid(modifier: Modifier = Modifier) {
  Column(
    modifier.fillMaxWidth().padding(Space.XL.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.Center,
  ) {
    Icon(
      Icons.Default.SearchOff,
      null,
      tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f),
      modifier = Modifier.size(44.dp),
    )
    Spacer(Modifier.height(Space.S.dp))
    Text("Nothing here", style = MaterialTheme.typography.titleLarge)
    Text(
      "Try another brand, or scan the barcode.",
      style = MaterialTheme.typography.bodyMedium,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
      textAlign = TextAlign.Center,
    )
  }
}

// ---------------------------------------------------------------- folders
//
// Brand, then model, then flavour -- as folders you open, not filters you
// apply.
//
// The chips this replaces were a filter over a list that was always visible:
// tapping Vapes showed a hundred and thirty-four products at once and left the
// cashier to narrow them down. That is a spreadsheet, and it is the wrong shape
// for someone standing at a counter with a customer waiting. A folder answers
// one question at a time -- which brand, then which model, then which flavour --
// and each answer is a single unambiguous tap on something the cashier can
// recognise by its picture before they have read a word of it.

/** One brand or model folder: a picture, a name, and how much is inside. */
@Composable
private fun FolderCard(
  name: String,
  count: Int,
  sublabel: String?,
  coverImageUrl: String?,
  onTap: () -> Unit,
) {
  Column(
    Modifier
      .clip(RoundedCornerShape(Corner.CARD.dp))
      .background(MaterialTheme.colorScheme.surface)
      .border(1.dp, MaterialTheme.colorScheme.outline, RoundedCornerShape(Corner.CARD.dp))
      .clickable(onClick = onTap)
      .padding(Space.S.dp),
  ) {
    Box(
      Modifier
        .fillMaxWidth()
        .aspectRatio(1.25f)
        .clip(RoundedCornerShape(Corner.CHIP.dp))
        .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f)),
      contentAlignment = Alignment.Center,
    ) {
      if (coverImageUrl != null) {
        AsyncImage(
          model = productImageUrlLarge(coverImageUrl),
          contentDescription = null,
          contentScale = ContentScale.Fit,
          modifier = Modifier.fillMaxSize().padding(Space.XS.dp),
        )
      } else {
        // The brand's initials rather than a folder glyph. A cashier scanning
        // the wall for Foger is looking for the word, and two big letters read
        // from further away than an icon that is the same on every tile.
        Text(
          name.split(' ').filter { it.isNotBlank() }.take(2)
            .joinToString("") { it.first().uppercase() },
          style = MaterialTheme.typography.displaySmall,
          fontWeight = FontWeight.Bold,
          color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.40f),
        )
      }
    }
    Spacer(Modifier.height(Space.S.dp))
    Text(
      name,
      style = MaterialTheme.typography.titleMedium,
      fontWeight = FontWeight.Bold,
      maxLines = 2,
      overflow = TextOverflow.Ellipsis,
    )
    Text(
      sublabel ?: if (count == 1) "1 item" else "$count items",
      style = MaterialTheme.typography.labelMedium,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
      maxLines = 1,
    )
  }
}

/** The brand folders inside whatever category the cashier is standing in. */
@Composable
fun BrandFolderGrid(
  brands: List<BrandNode>,
  onOpen: (BrandNode) -> Unit,
  modifier: Modifier = Modifier,
) {
  if (brands.isEmpty()) {
    EmptyGrid(modifier)
    return
  }
  LazyVerticalGrid(
    columns = GridCells.Adaptive(minSize = Touch.FOLDER.dp),
    modifier = modifier.padding(horizontal = Space.M.dp),
    horizontalArrangement = Arrangement.spacedBy(Space.S.dp),
    verticalArrangement = Arrangement.spacedBy(Space.S.dp),
    contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = Space.M.dp),
  ) {
    items(brands, key = { it.id }) { brand ->
      FolderCard(
        name = brand.name,
        count = brand.itemCount,
        // Say how many models are inside, because that is what the next tap
        // will be choosing between.
        sublabel = if (brand.hasModelChoice) {
          "${brand.lines.size} models · ${brand.itemCount} items"
        } else {
          null
        },
        coverImageUrl = brand.coverImageUrl,
        onTap = { onOpen(brand) },
      )
    }
  }
}

/** The model folders inside one brand. */
@Composable
fun LineFolderGrid(
  lines: List<LineNode>,
  onOpen: (LineNode) -> Unit,
  modifier: Modifier = Modifier,
) {
  if (lines.isEmpty()) {
    EmptyGrid(modifier)
    return
  }
  LazyVerticalGrid(
    columns = GridCells.Adaptive(minSize = Touch.FOLDER.dp),
    modifier = modifier.padding(horizontal = Space.M.dp),
    horizontalArrangement = Arrangement.spacedBy(Space.S.dp),
    verticalArrangement = Arrangement.spacedBy(Space.S.dp),
    contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = Space.M.dp),
  ) {
    items(lines, key = { it.id }) { line ->
      FolderCard(
        name = line.name,
        count = line.variantIds.size,
        sublabel = null,
        coverImageUrl = line.coverImageUrl,
        onTap = { onOpen(line) },
      )
    }
  }
}
