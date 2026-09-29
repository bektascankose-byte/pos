package com.snappos.pos.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.snappos.pos.R

/**
 * The shop's mark.
 *
 * Shipped as a transparent PNG and never tinted: it carries its own
 * orange-to-red gradient, and a `tint` would flatten the thing that makes it
 * recognisable. Everything else that wants to look like the brand takes its
 * colours from [BrandGradient], which was sampled from this file, so the two
 * cannot drift apart.
 */
@Composable
fun SnapPosMark(size: Dp = 34.dp, modifier: Modifier = Modifier) {
  Image(
    painter = painterResource(R.drawable.snappos_mark),
    contentDescription = "SnapPOS",
    contentScale = ContentScale.Fit,
    modifier = modifier.size(size),
  )
}

/** The wordmark, with the mark's own gradient poured through the letters. */
@Composable
fun SnapPosWordmark(style: TextStyle = MaterialTheme.typography.titleLarge) {
  Text(
    "SnapPOS",
    style = style.copy(brush = BrandGradient, fontWeight = FontWeight.Bold, letterSpacing = (-0.4).sp),
  )
}

/** Wordmark over a quiet caption. The header, the lock screen and the idle screen all use it. */
@Composable
fun BrandLockup(caption: String? = null, style: TextStyle = MaterialTheme.typography.titleLarge) {
  Column {
    SnapPosWordmark(style)
    caption?.let {
      Text(
        it,
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }
  }
}

/** A hairline in the brand gradient, fading out. Underlines the header without adding a colour. */
val BrandHairline: Brush = Brush.horizontalGradient(listOf(BrandOrange, BrandRed, Color.Transparent))
