package com.snappos.pos.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * Design tokens, from architecture section O.
 *
 * Dark by default. Not a stylistic preference: a bright screen behind a counter
 * for a ten hour shift is fatiguing, and a dark surface makes the cart the
 * brightest thing in the room, which is where the cashier's eyes belong. Light
 * mode is fully supported and is a per device setting.
 */
private val Ink = Color(0xFF0B0F14)
private val Surface = Color(0xFF121822)
private val SurfaceHigh = Color(0xFF1A2230)
private val Line = Color(0xFF263141)
private val TextPrimary = Color(0xFFF2F5F9)
private val TextSecondary = Color(0xFF9AA7B8)

/** One accent, used only for actions. When something is this colour it means something. */
private val Accent = Color(0xFF3B82F6)
private val Positive = Color(0xFF10B981)
private val Warning = Color(0xFFF59E0B)
private val Danger = Color(0xFFEF4444)

private val DarkScheme = darkColorScheme(
  primary = Accent,
  onPrimary = Color.White,
  background = Ink,
  onBackground = TextPrimary,
  surface = Surface,
  onSurface = TextPrimary,
  surfaceVariant = SurfaceHigh,
  onSurfaceVariant = TextSecondary,
  outline = Line,
  error = Danger,
  tertiary = Positive,
  secondary = Warning,
)

private val LightScheme = lightColorScheme(
  primary = Accent,
  onPrimary = Color.White,
  background = Color(0xFFF7F9FC),
  onBackground = Color(0xFF0B0F14),
  surface = Color.White,
  onSurface = Color(0xFF0B0F14),
  surfaceVariant = Color(0xFFEEF2F7),
  onSurfaceVariant = Color(0xFF52627A),
  outline = Color(0xFFD6DEE9),
  error = Danger,
  tertiary = Positive,
  secondary = Warning,
)

/**
 * Tabular numerals, mandatory on every money figure.
 *
 * Money in a proportional font is the single most common way a retail interface
 * looks cheap: columns of prices fail to align and a changing total shimmers as
 * digits change width. `tnum` fixes every digit to the same advance.
 */
val MoneyTextStyle = TextStyle(
  fontFamily = FontFamily.Monospace,
  fontFeatureSettings = "tnum",
  fontWeight = FontWeight.Medium,
)

private val PosTypography = Typography(
  displaySmall = TextStyle(fontSize = 32.sp, fontWeight = FontWeight.SemiBold),
  headlineMedium = TextStyle(fontSize = 24.sp, fontWeight = FontWeight.SemiBold),
  titleLarge = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.Medium),
  bodyLarge = TextStyle(fontSize = 16.sp),
  bodyMedium = TextStyle(fontSize = 14.sp),
  labelMedium = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Medium),
)

@Composable
fun SnapPosTheme(
  darkTheme: Boolean = isSystemInDarkTheme(),
  content: @Composable () -> Unit,
) {
  MaterialTheme(
    colorScheme = if (darkTheme) DarkScheme else LightScheme,
    typography = PosTypography,
    content = content,
  )
}

/** 8pt grid, from section O. Referenced rather than typed as literals. */
object Space {
  const val XS = 4
  const val S = 8
  const val M = 16
  const val L = 24
  const val XL = 32
}

/**
 * Minimum touch targets. 56dp for anything a cashier taps, 72dp for PAY and the
 * tender buttons, which are hit hundreds of times a shift and are the two
 * places a mis-tap costs the most time to undo.
 */
object Touch {
  const val MIN = 56
  const val PRIMARY = 72
  const val TILE = 120
}
