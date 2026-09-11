package com.snappos.pos.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.snappos.domain.Money

/**
 * Opening the drawer.
 *
 * Stands between unlocking and selling because a cash sale has to go somewhere.
 * Without a session the drawer total is unknowable, and over/short — the number
 * an owner actually looks at every day — becomes meaningless.
 *
 * The float is entered as minor units, like every other amount on this
 * register: a decimal point is a keypress that can be missed by a factor of a
 * hundred.
 */
@Composable
fun DrawerScreen(
  cashierName: String,
  message: Toast?,
  busy: Boolean,
  onOpen: (Money) -> Unit,
  onLock: () -> Unit,
) {
  var digits by remember { mutableStateOf("") }
  val float = Money.ofMinor(digits.ifEmpty { "0" }.toLong())

  Surface(color = MaterialTheme.colorScheme.background) {
    // Same lesson as the cash dialog: a landscape phone has roughly 380dp of
    // height, and stacking the float, the keypad and the button put OPEN DRAWER
    // below the bottom of the screen — which made starting a shift impossible
    // rather than awkward. Short screens put the keypad beside the rest.
    BoxWithConstraints(Modifier.fillMaxSize().padding(Space.M.dp)) {
      val sideBySide = maxHeight < 560.dp

      @Composable
      fun Details() {
        Text(
          "Good shift, $cashierName",
          style = MaterialTheme.typography.headlineMedium,
          fontWeight = FontWeight.SemiBold,
        )
        Text(
          "Count the opening float to open the drawer",
          style = MaterialTheme.typography.bodyMedium,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(Space.M.dp))
        Text(
          float.toMajorString(),
          style = MaterialTheme.typography.displaySmall.merge(MoneyTextStyle),
          color = MaterialTheme.colorScheme.primary,
        )
        message?.let {
          Spacer(Modifier.height(Space.S.dp))
          Text(
            it.text,
            style = MaterialTheme.typography.bodyMedium,
            color = if (it.isError) MaterialTheme.colorScheme.error
            else MaterialTheme.colorScheme.tertiary,
          )
        }
        Spacer(Modifier.height(Space.M.dp))
        Row(
          Modifier.fillMaxWidth(),
          horizontalArrangement = Arrangement.spacedBy(Space.S.dp),
        ) {
          // The floats a shop actually starts a drawer with.
          for (amount in listOf(10000L, 15000L, 20000L)) {
            Box(
              Modifier
                .weight(1f)
                .height(Touch.MIN.dp)
                .clip(RoundedCornerShape(6.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant)
                .clickable { digits = amount.toString() },
              contentAlignment = Alignment.Center,
            ) {
              Text(
                "$${amount / 100}",
                style = MaterialTheme.typography.bodyLarge.merge(MoneyTextStyle),
              )
            }
          }
        }
      }

      @Composable
      fun Actions() {
        Button(
          onClick = { onOpen(float) },
          enabled = !busy,
          modifier = Modifier.fillMaxWidth().height(Touch.PRIMARY.dp),
          shape = RoundedCornerShape(6.dp),
        ) {
          Text(
            "OPEN DRAWER",
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.SemiBold,
          )
        }
        TextButton(onClick = onLock) { Text("Not me — lock the register") }
      }

      if (sideBySide) {
        Row(Modifier.fillMaxSize()) {
          Column(Modifier.weight(1f).padding(end = Space.M.dp)) {
            Details()
            Spacer(Modifier.weight(1f))
            Actions()
          }
          Column(Modifier.weight(1f), verticalArrangement = Arrangement.Center) {
            SimpleKeypad(
              onDigit = { if (digits.length < 7) digits += it },
              onBackspace = { digits = digits.dropLast(1) },
              onClear = { digits = "" },
            )
          }
        }
      } else {
        Column(
          Modifier.fillMaxSize(),
          verticalArrangement = Arrangement.Center,
          horizontalAlignment = Alignment.CenterHorizontally,
        ) {
          Column(Modifier.width(360.dp)) {
            Details()
            Spacer(Modifier.height(Space.M.dp))
            SimpleKeypad(
              onDigit = { if (digits.length < 7) digits += it },
              onBackspace = { digits = digits.dropLast(1) },
              onClear = { digits = "" },
            )
            Spacer(Modifier.height(Space.M.dp))
            Actions()
          }
        }
      }
    }
  }
}

/** The same keypad as the cash dialog, so a cashier learns one layout. */
@Composable
fun SimpleKeypad(
  onDigit: (String) -> Unit,
  onBackspace: () -> Unit,
  onClear: () -> Unit,
) {
  val rows = listOf(
    listOf("1", "2", "3"),
    listOf("4", "5", "6"),
    listOf("7", "8", "9"),
    listOf("C", "0", "<"),
  )
  Column(verticalArrangement = Arrangement.spacedBy(Space.S.dp)) {
    rows.forEach { row ->
      Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.S.dp)) {
        row.forEach { key ->
          Box(
            Modifier
              .weight(1f)
              .height(Touch.MIN.dp)
              .clip(RoundedCornerShape(6.dp))
              .background(MaterialTheme.colorScheme.surfaceVariant)
              .clickable {
                when (key) {
                  "C" -> onClear()
                  "<" -> onBackspace()
                  else -> onDigit(key)
                }
              },
            contentAlignment = Alignment.Center,
          ) {
            Text(key, style = MaterialTheme.typography.headlineMedium.merge(MoneyTextStyle))
          }
        }
      }
    }
  }
}
