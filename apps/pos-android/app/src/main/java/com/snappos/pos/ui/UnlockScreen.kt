package com.snappos.pos.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.snappos.data.RosterDiagnosis
import com.snappos.data.entities.EmployeeEntity

/**
 * Unlocking the register.
 *
 * Pick a name, enter a PIN. Verified on device against the replicated Argon2id
 * hash, so a shift can start on a register that cannot reach anything — which
 * is when shifts usually start.
 *
 * Names are listed rather than typed. A cashier at the start of a rush should
 * be two taps from selling, and a shop knows who its staff are; there is no
 * secrecy to protect by hiding a list the whole team can see on the rota.
 */
@Composable
fun UnlockScreen(
  employees: List<EmployeeEntity>,
  message: String?,
  busy: Boolean,
  onUnlock: (userId: String, pin: String) -> Unit,
  rosterDiagnosis: RosterDiagnosis? = null,
) {
  var selected by remember { mutableStateOf<EmployeeEntity?>(null) }
  var pin by remember { mutableStateOf("") }

  Surface(color = MaterialTheme.colorScheme.background) {
    Row(Modifier.fillMaxSize().padding(Space.L.dp)) {

      Column(Modifier.weight(1f).fillMaxHeight()) {
        Text(
          "SnapPOS",
          style = MaterialTheme.typography.displaySmall,
          fontWeight = FontWeight.SemiBold,
        )
        Text(
          "Select your name to start a shift",
          style = MaterialTheme.typography.bodyMedium,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(Space.L.dp))

        if (employees.isEmpty()) {
          // Say which of the four situations this is, not the most likely one.
          //
          // "No staff on this register yet. Connect to the server to set it
          // up." reads as a diagnosis and is really a guess: a register that
          // synced fine and was handed an empty roster shows exactly the same
          // words, and re-syncing will never fix it. A till that will not open
          // is the worst failure this product has, and whoever is standing at
          // it has to be able to say something useful down the phone.
          val (headline, detail) = when (rosterDiagnosis) {
            RosterDiagnosis.NotProvisioned ->
              "This register has not been set up yet." to
                "Claim it for a store, then it will pull its staff."

            RosterDiagnosis.NeverSynced ->
              "No staff on this register yet." to
                "It has never finished syncing. Check the connection to the server."

            is RosterDiagnosis.ServerListedNobody ->
              "The server listed no staff for ${rosterDiagnosis.storeCode}." to
                "Syncing again will not change this. Someone has to be assigned " +
                  "to this store, and this register has to be pointed at the " +
                  "right one."

            is RosterDiagnosis.AllInactive ->
              "Every member of staff here is inactive." to
                "${rosterDiagnosis.total} are on this register and none can sign " +
                  "in. Reactivate someone on the server."

            // The diagnosis has not arrived yet; do not guess in the meantime.
            null -> "No staff on this register yet." to "Checking why."
          }

          Text(
            headline,
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.secondary,
          )
          Text(
            detail,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
          )
        }

        LazyColumn(verticalArrangement = Arrangement.spacedBy(Space.S.dp)) {
          items(employees, key = { it.id }) { employee ->
            EmployeeRow(
              employee = employee,
              selected = selected?.id == employee.id,
              onClick = {
                selected = employee
                pin = ""
              },
            )
          }
        }
      }

      Spacer(Modifier.width(Space.XL.dp))

      Column(Modifier.weight(1f).fillMaxHeight(), verticalArrangement = Arrangement.Center) {
        Text(
          selected?.displayName ?: "Select a name",
          style = MaterialTheme.typography.headlineMedium,
          color = if (selected == null) MaterialTheme.colorScheme.onSurfaceVariant
          else MaterialTheme.colorScheme.onBackground,
        )
        Spacer(Modifier.height(Space.M.dp))

        PinDots(pin.length)

        message?.let {
          Spacer(Modifier.height(Space.S.dp))
          Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
        }

        Spacer(Modifier.height(Space.M.dp))
        PinPad(
          enabled = selected != null && !busy,
          onDigit = {
            if (pin.length < 8) {
              pin += it
              // Four digits is the common case, so submit at four rather than
              // making a cashier reach for a confirm key hundreds of times a day.
              if (pin.length == 4) {
                onUnlock(selected!!.id, pin)
                pin = ""
              }
            }
          },
          onBackspace = { pin = pin.dropLast(1) },
          onClear = { pin = "" },
        )
      }
    }
  }
}

@Composable
private fun EmployeeRow(employee: EmployeeEntity, selected: Boolean, onClick: () -> Unit) {
  val lockedUntil = employee.lockedUntilMillis
  val locked = lockedUntil != null && lockedUntil > System.currentTimeMillis()

  Row(
    Modifier
      .fillMaxWidth()
      .height(Touch.MIN.dp)
      .clip(RoundedCornerShape(6.dp))
      .background(
        if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.15f)
        else MaterialTheme.colorScheme.surface,
      )
      .clickable(enabled = !locked, onClick = onClick)
      .padding(horizontal = Space.M.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(
      employee.displayName,
      style = MaterialTheme.typography.bodyLarge,
      color = when {
        locked -> MaterialTheme.colorScheme.onSurfaceVariant
        selected -> MaterialTheme.colorScheme.primary
        else -> MaterialTheme.colorScheme.onSurface
      },
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
      modifier = Modifier.weight(1f),
    )
    if (locked) {
      Text(
        "LOCKED",
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.error,
      )
    }
  }
}

/** Dots rather than digits: a PIN entered at a counter is entered in public. */
@Composable
private fun PinDots(count: Int) {
  Row(horizontalArrangement = Arrangement.spacedBy(Space.S.dp)) {
    repeat(maxOf(4, count)) { index ->
      Box(
        Modifier
          .size(16.dp)
          .clip(CircleShape)
          .background(
            if (index < count) MaterialTheme.colorScheme.primary
            else MaterialTheme.colorScheme.surfaceVariant,
          ),
      )
    }
  }
}

@Composable
private fun PinPad(
  enabled: Boolean,
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
  Column(verticalArrangement = Arrangement.spacedBy(Space.S.dp), modifier = Modifier.width(280.dp)) {
    rows.forEach { row ->
      Row(horizontalArrangement = Arrangement.spacedBy(Space.S.dp)) {
        row.forEach { key ->
          Box(
            Modifier
              .weight(1f)
              .height(Touch.MIN.dp)
              .clip(RoundedCornerShape(6.dp))
              .background(
                if (enabled) MaterialTheme.colorScheme.surfaceVariant
                else MaterialTheme.colorScheme.surface,
              )
              .clickable(enabled = enabled) {
                when (key) {
                  "C" -> onClear()
                  "<" -> onBackspace()
                  else -> onDigit(key)
                }
              },
            contentAlignment = Alignment.Center,
          ) {
            Text(
              key,
              style = MaterialTheme.typography.headlineMedium.merge(MoneyTextStyle),
              color = if (enabled) MaterialTheme.colorScheme.onSurface
              else MaterialTheme.colorScheme.onSurfaceVariant,
            )
          }
        }
      }
    }
  }
}
