package com.snappos.pos.ui

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * Design tokens.
 *
 * **Light, and light is the default.** The original note here argued for dark:
 * a bright screen behind a counter for a ten hour shift is fatiguing, and a
 * dark surface makes the cart the brightest thing in the room. The argument is
 * sound and it was still wrong, because it was made about a register nobody had
 * stood in front of yet. On the actual counter the dark build read as heavy and
 * crowded, and the person who works that counter every day asked for light. The
 * dark scheme is still built and still selectable per device.
 *
 * The palette is cool grey with exactly one warm accent, taken from the shop's
 * own mark. One accent is the whole discipline: when something on this screen
 * is orange it is either the brand or the thing to press, and a cashier learns
 * that in a shift without being told.
 */

// ------------------------------------------------------------------ the brand
//
// Sampled from the SnapPOS mark itself rather than guessed at, so the header,
// the CHARGE button and the logo above them are provably the same colour.
val BrandOrange = Color(0xFFE07012)
val BrandRed = Color(0xFFDD2F1C)

/** The mark's own gradient, bottom-left to top-right, as it is drawn. */
val BrandGradient = Brush.linearGradient(listOf(BrandOrange, BrandRed))

/** The same gradient, near-flat, for large fills that must not look painted. */
val BrandWash = Brush.linearGradient(
  listOf(BrandOrange.copy(alpha = 0.10f), BrandRed.copy(alpha = 0.06f)),
)

// ------------------------------------------------------------------- neutrals
private val Canvas = Color(0xFFF2F5FA)
private val Panel = Color(0xFFFFFFFF)
private val Raised = Color(0xFFE9EEF6)
private val Line = Color(0xFFDCE3ED)
private val Ink = Color(0xFF0D1524)
private val InkMuted = Color(0xFF5A6B84)

// ------------------------------------------------------------------- meanings
//
// Danger is deliberately a colder, darker red than the brand's. They sit on the
// same screen and must never be mistaken for one another: one of them means
// "press this to take money" and the other means "this sale is about to go
// wrong".
private val Positive = Color(0xFF0F8A5F)
private val Caution = Color(0xFFB4700A)
private val Danger = Color(0xFFB3261E)

private val LightScheme = lightColorScheme(
  primary = BrandOrange,
  onPrimary = Color.White,
  primaryContainer = Color(0xFFFDEEE0),
  onPrimaryContainer = Color(0xFF7A3A05),
  background = Canvas,
  onBackground = Ink,
  surface = Panel,
  onSurface = Ink,
  surfaceVariant = Raised,
  onSurfaceVariant = InkMuted,
  outline = Line,
  outlineVariant = Color(0xFFC4CEDC),
  error = Danger,
  onError = Color.White,
  errorContainer = Color(0xFFFBE7E5),
  onErrorContainer = Color(0xFF7A1A15),
  tertiary = Positive,
  secondary = Caution,
  onSecondary = Color.White,
  secondaryContainer = Color(0xFFFCF0D8),
  onSecondaryContainer = Color(0xFF6E4600),
)

private val DarkScheme = darkColorScheme(
  primary = Color(0xFFF08A32),
  onPrimary = Color(0xFF3B1A00),
  primaryContainer = Color(0xFF5C2E06),
  onPrimaryContainer = Color(0xFFFFE0C4),
  background = Color(0xFF0A0E17),
  onBackground = Color(0xFFF5F7FB),
  surface = Color(0xFF121826),
  onSurface = Color(0xFFF5F7FB),
  surfaceVariant = Color(0xFF1B2333),
  onSurfaceVariant = Color(0xFF9FAFC6),
  outline = Color(0xFF2A3446),
  outlineVariant = Color(0xFF3A4557),
  error = Color(0xFFFF8A80),
  tertiary = Color(0xFF3FD69B),
  secondary = Color(0xFFFFC46B),
)

/**
 * Tabular numerals, mandatory on every money figure.
 *
 * Money in a proportional font is the single most common way a retail interface
 * looks cheap: columns of prices fail to align and a changing total shimmers as
 * digits change width. `tnum` fixes every digit to the same advance.
 */
val MoneyTextStyle = TextStyle(
  fontFeatureSettings = "tnum",
  fontWeight = FontWeight.Medium,
)

private val PosTypography = Typography(
  displayMedium = TextStyle(fontSize = 46.sp, fontWeight = FontWeight.Bold, letterSpacing = (-1).sp),
  displaySmall = TextStyle(fontSize = 34.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.5).sp),
  headlineMedium = TextStyle(fontSize = 25.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.25).sp),
  headlineSmall = TextStyle(fontSize = 21.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.2).sp),
  titleLarge = TextStyle(fontSize = 19.sp, fontWeight = FontWeight.SemiBold),
  titleMedium = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
  bodyLarge = TextStyle(fontSize = 16.sp),
  bodyMedium = TextStyle(fontSize = 14.sp),
  labelLarge = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
  labelMedium = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.2.sp),
  labelSmall = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.6.sp),
)

@Composable
fun SnapPosTheme(
  darkTheme: Boolean = false,
  content: @Composable () -> Unit,
) {
  MaterialTheme(
    colorScheme = if (darkTheme) DarkScheme else LightScheme,
    typography = PosTypography,
    content = content,
  )
}

/** 8pt grid. Referenced rather than typed as literals. */
object Space {
  const val XS = 4
  const val S = 8
  const val M = 16
  const val L = 24
  const val XL = 32
}

/** Corner radii. Large and consistent; a till with six different radii looks assembled rather than designed. */
object Corner {
  const val CHIP = 12
  const val CONTROL = 14
  const val CARD = 18
  const val PANEL = 24
}

/**
 * Minimum touch targets. 56dp for anything a cashier taps, 72dp for CHARGE and
 * the tender buttons, which are hit hundreds of times a shift and are the two
 * places a mis-tap costs the most time to undo.
 */
object Touch {
  const val MIN = 56
  const val PRIMARY = 72

  /**
   * The smallest a product tile may be, which sets how many fit across.
   *
   * Grown again, from 168, when the tiles started carrying real photographs.
   * The whole point of a picture on a tile is that a cashier finds the product
   * without reading, and a thumbnail small enough to need a caption is just a
   * caption with decoration.
   */
  const val TILE = 208

  /**
   * The smallest a brand or model folder may be.
   *
   * Wider than a product tile on purpose. A shop has a handful of brands and
   * dozens of flavours, so the folder screens can spend space on being
   * unmistakable across a counter while the flavour grid has to stay dense.
   */
  const val FOLDER = 240
}

/**
 * Motion.
 *
 * Every duration here is under a fifth of a second, and one path has none at
 * all: **nothing on the scan-to-cart route animates.** A row that animates in
 * is a row the cashier waits for, and the budget from HID input to rendered row
 * is 120ms. Motion is for changes the cashier chose -- opening a menu, drilling
 * into a brand -- where it explains where things went. It is never for changes
 * that happen to them.
 */
object Motion {
  const val FAST = 120
  const val NORMAL = 180
  const val SLOW = 260
  /** Standard ease, slightly weighted to the exit so things feel like they settle. */
  val Ease: Easing = CubicBezierEasing(0.2f, 0f, 0f, 1f)
  val EaseOut: Easing = CubicBezierEasing(0.05f, 0.7f, 0.1f, 1f)
}
