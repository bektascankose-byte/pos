package com.snappos.pos.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.cos
import kotlin.math.sin

/**
 * How long the counter stays quiet before the register stops looking busy.
 *
 * Long enough that it never appears between two customers in a queue, short
 * enough to be up by the time somebody walks in. A screensaver that shows up
 * mid-transaction is not a screensaver, it is an interruption.
 */
private const val IDLE_AFTER_MILLIS = 45_000L

/**
 * Is the counter quiet?
 *
 * [activity] is anything that counts as the cashier being present -- a tap, a
 * scan, a cart with something in it. Changing it restarts the clock. Deliberately
 * a plain key rather than a listener: every real interaction already changes
 * some piece of state, so there is nothing to remember to wire up, and no way
 * for a new control to be added later that silently fails to keep the screen
 * awake.
 */
@Composable
fun rememberIdle(activity: Any?, enabled: Boolean = true): Boolean {
  var idle by remember { mutableStateOf(false) }
  LaunchedEffect(activity, enabled) {
    idle = false
    if (!enabled) return@LaunchedEffect
    delay(IDLE_AFTER_MILLIS)
    idle = true
  }
  return idle && enabled
}

/**
 * The idle screen.
 *
 * It sits over the product grid and not over the whole register: the cart, the
 * totals and CHARGE stay visible and live underneath, so a held sale waiting to
 * be resumed is still readable from across the shop and a scanner fired at the
 * counter still lands in the cart. It is ambient, not modal.
 *
 * The motion is three slow blooms of the shop's own gradient, drifting on
 * different periods so the pattern never visibly repeats. Everything is drawn
 * in one Canvas pass with no layout work, and it only runs while nothing else
 * is happening.
 */
@Composable
fun IdleOverlay(
  visible: Boolean,
  storeName: String,
  heldCount: Int,
  onDismiss: () -> Unit,
  modifier: Modifier = Modifier,
) {
  AnimatedVisibility(
    visible = visible,
    enter = fadeIn(tween(900)),
    exit = fadeOut(tween(Motion.NORMAL)),
    modifier = modifier,
  ) {
    val drift = rememberInfiniteTransition(label = "idle")
    val a by drift.animateFloat(
      0f, (2 * Math.PI).toFloat(),
      infiniteRepeatable(tween(28_000, easing = androidx.compose.animation.core.LinearEasing)),
      label = "a",
    )
    val b by drift.animateFloat(
      0f, (2 * Math.PI).toFloat(),
      infiniteRepeatable(tween(41_000, easing = androidx.compose.animation.core.LinearEasing)),
      label = "b",
    )
    val breathe by drift.animateFloat(
      0.92f, 1.08f,
      infiniteRepeatable(tween(6_000, easing = Motion.Ease), RepeatMode.Reverse),
      label = "breathe",
    )

    var clock by remember { mutableStateOf(now()) }
    LaunchedEffect(Unit) {
      while (true) {
        clock = now()
        delay(20_000)
      }
    }

    Box(
      Modifier
        .fillMaxSize()
        .background(MaterialTheme.colorScheme.background)
        // Any touch anywhere wakes it. A screensaver with a dismiss button is
        // a dialog.
        .pointerInput(Unit) { detectAnyPress(onDismiss) },
      contentAlignment = Alignment.Center,
    ) {
      Canvas(Modifier.fillMaxSize()) {
        val w = size.width
        val h = size.height
        fun bloom(centre: Offset, radius: Float, colour: Color) {
          drawCircle(
            brush = Brush.radialGradient(
              listOf(colour, Color.Transparent),
              center = centre,
              radius = radius,
            ),
            radius = radius,
            center = centre,
          )
        }
        bloom(
          Offset(w * (0.30f + 0.14f * cos(a)), h * (0.34f + 0.18f * sin(a))),
          w * 0.42f * breathe,
          BrandOrange.copy(alpha = 0.16f),
        )
        bloom(
          Offset(w * (0.70f + 0.16f * cos(b + 1.9f)), h * (0.62f + 0.16f * sin(b))),
          w * 0.38f * breathe,
          BrandRed.copy(alpha = 0.13f),
        )
        bloom(
          Offset(w * (0.52f + 0.22f * cos(a * 0.6f + 3.1f)), h * (0.18f + 0.10f * sin(b * 1.3f))),
          w * 0.30f,
          BrandOrange.copy(alpha = 0.08f),
        )
      }

      Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
        modifier = Modifier.padding(Space.XL.dp),
      ) {
        SnapPosMark(size = 96.dp)
        Spacer(Modifier.height(Space.M.dp))
        SnapPosWordmark(MaterialTheme.typography.displaySmall)
        Spacer(Modifier.height(Space.XS.dp))
        Text(
          storeName,
          style = MaterialTheme.typography.titleLarge,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
          textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(Space.XL.dp))
        Text(
          clock,
          style = MaterialTheme.typography.displayMedium.merge(MoneyTextStyle),
          fontWeight = FontWeight.Light,
          color = MaterialTheme.colorScheme.onBackground.copy(alpha = 0.85f),
        )
        Spacer(Modifier.height(Space.L.dp))
        Text(
          if (heldCount > 0) {
            "$heldCount sale${if (heldCount == 1) "" else "s"} on hold  ·  touch to continue"
          } else {
            "Touch anywhere, or scan to begin"
          },
          style = MaterialTheme.typography.bodyLarge,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
      }
    }
  }
}

private fun now(): String = SimpleDateFormat("h:mm a", Locale.getDefault()).format(Date())

private suspend fun androidx.compose.ui.input.pointer.PointerInputScope.detectAnyPress(onPress: () -> Unit) {
  awaitPointerEventScope {
    while (true) {
      awaitPointerEvent()
      onPress()
    }
  }
}
