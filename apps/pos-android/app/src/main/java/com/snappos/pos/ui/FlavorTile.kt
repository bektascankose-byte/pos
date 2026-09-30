package com.snappos.pos.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.snappos.domain.hueFor

/**
 * A flavour with no photograph, drawn as one.
 *
 * Most of a real shop's catalog has never been photographed, and every tile
 * in the grid is the same size whether or not anyone got round to it. A grid
 * of grey rectangles gives the eye nothing to aim at, and -- worse -- five
 * unphotographed flavours of one product were five identical rectangles that
 * a cashier had to read the caption of to tell apart. That is the moment
 * somebody hands over the wrong box.
 *
 * So the name becomes the picture: set large, in a colour of its own, filling
 * the space a photograph would have. It is still obviously not a photograph,
 * which is the point -- it should look like a thing waiting for one.
 *
 * The same name gets the same colour here and in the back office, because
 * `hueFor` is the same hash on both sides. Somebody who set up "Honey Berry"
 * at the desk sees that colour again on the till.
 */
@Composable
fun FlavorTile(name: String, modifier: Modifier = Modifier) {
  val hue = hueFor(name).toFloat()
  Box(
    modifier
      .fillMaxSize()
      .background(Color.hsl(hue, 0.45f, 0.22f)),
    contentAlignment = Alignment.Center,
  ) {
    Text(
      name,
      style = MaterialTheme.typography.titleMedium,
      fontWeight = FontWeight.SemiBold,
      color = Color.hsl(hue, 0.70f, 0.88f),
      textAlign = TextAlign.Center,
      maxLines = 3,
      overflow = TextOverflow.Ellipsis,
      modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
    )
  }
}


