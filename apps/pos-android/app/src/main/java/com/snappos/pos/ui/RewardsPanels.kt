package com.snappos.pos.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Backspace
import androidx.compose.material.icons.filled.Cake
import androidx.compose.material.icons.filled.CardGiftcard
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.LocalOffer
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.snappos.domain.Money
import com.snappos.domain.RewardsInput
import kotlinx.coroutines.delay

/**
 * The rewards side of the customer's screen.
 *
 * One panel at a time, and each asks for one thing. The person using it is a
 * stranger who will see it for twenty seconds, standing up, with a cashier
 * waiting: there is no room for a form, so the sign in is a keypad, the
 * birthday is twelve months and then a day, and every question can be turned
 * down with one tap that is always in the same corner.
 *
 * Nothing here is sized in fixed heights. The keys share whatever the screen
 * has left after the words, because customer displays come in whatever size
 * the till's maker fitted and a keypad that runs off the bottom of one loses
 * the button that says no.
 */
@Composable
fun RewardsSide(panel: RewardsPanel, actions: RewardsActions) {
  AnimatedContent(
    targetState = panel,
    transitionSpec = {
      (fadeIn(tween(Motion.SLOW)) + slideInVertically(tween(Motion.SLOW, easing = Motion.EaseOut)) { it / 8 })
        .togetherWith(fadeOut(tween(Motion.FAST)))
    },
    label = "rewards",
  ) { current ->
    Box(Modifier.fillMaxSize().padding(Space.L.dp), contentAlignment = Alignment.Center) {
      when (current) {
        RewardsPanel.Resting -> RewardsResting()
        is RewardsPanel.EnterPhone -> PhoneEntry(current.problem, actions)
        // Drawn across the whole screen by CustomerScreen: a keyboard does
        // not fit in this column.
        is RewardsPanel.EnterEmail -> Unit
        RewardsPanel.Working -> RewardsMessage("One moment") { CircularProgressIndicator(color = BrandOrange) }
        is RewardsPanel.ConfirmJoin -> JoinQuestion(current.contact, actions)
        is RewardsPanel.AskBirthday -> BirthdayQuestion(actions)
        is RewardsPanel.AskOffers -> OffersQuestion(current.channel, actions)
        is RewardsPanel.SignedIn -> MemberWelcome(current.member, actions)
        RewardsPanel.Declined -> RewardsDeclined(actions)
        is RewardsPanel.Unavailable -> RewardsUnavailable(current.message, actions)
      }
    }
  }
}

// --------------------------------------------------------------- phone number

/**
 * The keypad.
 *
 * The customer types their own number. That is the whole reason this is worth
 * building: a phone number read aloud across a counter and typed by a cashier
 * is wrong often enough that the rewards file fills up with near duplicates,
 * and the customer is the only person in the building who knows their own
 * number.
 *
 * A number that cannot exist is caught here, with the digits left in place to
 * fix, rather than sent and answered with an empty keypad.
 */
@Composable
private fun PhoneEntry(problem: String?, actions: RewardsActions) {
  var digits by remember { mutableStateOf("") }
  var slip by remember { mutableStateOf<String?>(null) }

  // A number left half typed is somebody's number, on a screen the next
  // customer is about to walk up to.
  LaunchedEffect(digits) {
    if (digits.isNotEmpty()) {
      delay(ABANDONED_ENTRY_MS)
      digits = ""
      slip = null
    }
  }

  fun press(key: String) {
    if (digits.length < 10) digits += key
    slip = null
  }

  val note = slip ?: problem
  Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
    Text("Rewards", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    Text("Enter your phone number", style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
    Text(
      note ?: "Earn points every time you shop",
      style = MaterialTheme.typography.bodyMedium,
      color = if (note != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
      textAlign = TextAlign.Center,
    )
    Spacer(Modifier.height(Space.S.dp))
    Text(
      typedPhone(digits),
      style = MaterialTheme.typography.headlineMedium.merge(MoneyTextStyle),
      color = if (digits.isEmpty()) MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f)
      else MaterialTheme.colorScheme.onSurface,
    )
    Spacer(Modifier.height(Space.M.dp))

    NumberPad(
      modifier = Modifier.weight(1f),
      ready = digits.length == 10,
      onDigit = ::press,
      onDelete = {
        digits = digits.dropLast(1)
        slip = null
      },
      onDone = {
        if (RewardsInput.phoneToE164(digits) != null) actions.submitPhone(digits)
        else slip = "Check the number and try again."
      },
    )

    Spacer(Modifier.height(Space.S.dp))
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
      QuietButton("Use email instead", onClick = actions::useEmail)
      QuietButton("No thanks", muted = true, onClick = actions::decline)
    }
  }
}

/** Ten digits, a delete and a confirm, sharing the height they are given. */
@Composable
private fun NumberPad(
  modifier: Modifier,
  ready: Boolean,
  onDigit: (String) -> Unit,
  onDelete: () -> Unit,
  onDone: () -> Unit,
) {
  Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Space.S.dp)) {
    listOf(listOf("1", "2", "3"), listOf("4", "5", "6"), listOf("7", "8", "9")).forEach { row ->
      Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.S.dp)) {
        row.forEach { key -> PadKey(key, Modifier.weight(1f).fillMaxHeight()) { onDigit(key) } }
      }
    }
    Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.S.dp)) {
      PadKey(DELETE, Modifier.weight(1f).fillMaxHeight(), muted = true, onClick = onDelete)
      PadKey("0", Modifier.weight(1f).fillMaxHeight()) { onDigit("0") }
      PadKey(DONE, Modifier.weight(1f).fillMaxHeight(), accent = ready, enabled = ready, onClick = onDone)
    }
  }
}

// ---------------------------------------------------------------------- email

/**
 * An email instead of a phone number, for a customer who would rather not
 * give one.
 *
 * It takes the whole screen. A keyboard needs ten keys across, and in the
 * rewards column each would be narrower than a fingertip. The basket is
 * hidden while they type, so the total stays in the corner: it is the one
 * thing they may glance up for.
 *
 * The keys are drawn here rather than borrowed from Android. The system
 * keyboard appears on the cashier's screen, not this one, and this window
 * never takes the keyboard in the first place so that the barcode scanner
 * keeps working.
 */
@Composable
fun EmailEntry(problem: String?, total: Money?, actions: RewardsActions) {
  var text by remember { mutableStateOf("") }
  var slip by remember { mutableStateOf<String?>(null) }

  fun type(key: String) {
    if (text.length + key.length <= EMAIL_MAX) text += key
    slip = null
    actions.touch()
  }

  /** A domain key finishes the address: it replaces whatever follows the @, or adds one. */
  fun finish(domain: String) {
    val at = text.indexOf('@')
    text = (if (at >= 0) text.take(at) else text) + domain
    slip = null
    actions.touch()
  }

  val note = slip ?: problem
  Column(
    Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).padding(Space.L.dp),
    verticalArrangement = Arrangement.spacedBy(Space.S.dp),
  ) {
    Row(verticalAlignment = Alignment.CenterVertically) {
      Column(Modifier.weight(1f)) {
        Text("Enter your email", style = MaterialTheme.typography.titleLarge)
        Text(
          note ?: "Earn points every time you shop",
          style = MaterialTheme.typography.bodyMedium,
          color = if (note != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
        )
      }
      total?.let {
        Text("Total $${it.toMajorString()}", style = MaterialTheme.typography.titleLarge.merge(MoneyTextStyle))
      }
    }

    val shape = RoundedCornerShape(Corner.CONTROL.dp)
    Box(
      Modifier
        .fillMaxWidth()
        .height(Touch.MIN.dp)
        .clip(shape)
        .background(MaterialTheme.colorScheme.surface)
        .border(
          1.dp,
          if (note != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.outlineVariant,
          shape,
        )
        .padding(horizontal = Space.M.dp),
      contentAlignment = Alignment.CenterStart,
    ) {
      Text(
        text.ifEmpty { "name@example.com" },
        // A long address drops a size rather than running off the end of the
        // field, where the part being typed would be the part not shown.
        style = if (text.length > EMAIL_LARGE_UNTIL) MaterialTheme.typography.titleMedium
        else MaterialTheme.typography.headlineSmall,
        color = if (text.isEmpty()) MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f)
        else MaterialTheme.colorScheme.onSurface,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
    }

    Column(Modifier.weight(1f).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Space.S.dp)) {
      EMAIL_ROWS.forEach { row ->
        Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.S.dp)) {
          row.forEach { key ->
            if (key == DELETE) {
              PadKey(key, Modifier.weight(1f).fillMaxHeight(), muted = true, corner = Corner.CHIP) {
                text = text.dropLast(1)
                slip = null
                actions.touch()
              }
            } else {
              PadKey(
                key,
                Modifier.weight(1f).fillMaxHeight(),
                textStyle = MaterialTheme.typography.headlineSmall,
                corner = Corner.CHIP,
              ) { type(key) }
            }
          }
        }
      }
      Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.S.dp)) {
        EMAIL_ENDINGS.forEach { ending ->
          PadKey(
            ending,
            Modifier.weight(1f).fillMaxHeight(),
            muted = true,
            textStyle = MaterialTheme.typography.titleMedium,
            corner = Corner.CHIP,
          ) { finish(ending) }
        }
      }
    }

    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
      QuietButton("Use phone number instead", onClick = actions::usePhone)
      Spacer(Modifier.width(Space.S.dp))
      QuietButton("No thanks", muted = true, onClick = actions::decline)
      Spacer(Modifier.weight(1f))
      Button(
        onClick = {
          val clean = text.trim().lowercase()
          if (RewardsInput.isEmail(clean)) actions.submitEmail(clean)
          else slip = "Check the email and try again."
        },
        enabled = text.isNotEmpty(),
        modifier = Modifier.width(EMAIL_CONTINUE_WIDTH.dp).height(Touch.MIN.dp),
        shape = RoundedCornerShape(6.dp),
      ) {
        Text("Continue", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
      }
    }
  }
}

// ----------------------------------------------------------------- questions

/**
 * A number or email that is not on file.
 *
 * Joining is asked, never assumed. The customer sees exactly what they typed
 * and chooses, which is also the moment a mistyped digit gets noticed.
 */
@Composable
private fun JoinQuestion(contact: RewardsContact, actions: RewardsActions) {
  val phone = contact is RewardsContact.Phone
  Column(horizontalAlignment = Alignment.CenterHorizontally) {
    Icon(Icons.Default.CardGiftcard, null, tint = BrandOrange, modifier = Modifier.size(52.dp))
    Spacer(Modifier.height(Space.M.dp))
    Text(
      contact.shown,
      style = if (phone) MaterialTheme.typography.headlineSmall.merge(MoneyTextStyle)
      else MaterialTheme.typography.titleLarge,
      textAlign = TextAlign.Center,
      maxLines = 2,
      overflow = TextOverflow.Ellipsis,
    )
    Spacer(Modifier.height(Space.S.dp))
    Text(
      if (phone) "This number is new here." else "This email is new here.",
      style = MaterialTheme.typography.titleLarge,
      textAlign = TextAlign.Center,
    )
    Text(
      "Join rewards and earn points every time you shop.",
      style = MaterialTheme.typography.bodyLarge,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
      textAlign = TextAlign.Center,
    )
    Spacer(Modifier.height(Space.L.dp))
    MainButton("Join rewards", onClick = actions::confirmJoin)
    Spacer(Modifier.height(Space.S.dp))
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
      QuietButton("Change it", onClick = actions::fixContact)
      QuietButton("No thanks", muted = true, onClick = actions::decline)
    }
  }
}

/**
 * Month, then day. No year.
 *
 * A birthday treat needs the day, not the age, and a shop that never asks
 * for the year never holds it. Twelve keys and then a number pad rather than
 * a date picker: a calendar is the slowest way there is to say "March 9".
 */
@Composable
private fun BirthdayQuestion(actions: RewardsActions) {
  var month by remember { mutableStateOf<Int?>(null) }
  var day by remember { mutableStateOf("") }

  Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
    Icon(Icons.Default.Cake, null, tint = BrandOrange, modifier = Modifier.size(40.dp))
    Spacer(Modifier.height(Space.S.dp))
    Text("When's your birthday?", style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
    Text(
      "We might have a birthday gift for you.",
      style = MaterialTheme.typography.bodyLarge,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
      textAlign = TextAlign.Center,
    )
    Spacer(Modifier.height(Space.M.dp))

    val chosen = month
    if (chosen == null) {
      Column(Modifier.weight(1f).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Space.S.dp)) {
        MONTHS.chunked(3).forEachIndexed { rowIndex, row ->
          Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.S.dp)) {
            row.forEachIndexed { column, name ->
              PadKey(
                name.take(3),
                Modifier.weight(1f).fillMaxHeight(),
                textStyle = MaterialTheme.typography.titleLarge,
              ) {
                month = rowIndex * 3 + column + 1
                actions.touch()
              }
            }
          }
        }
      }
    } else {
      val typed = day.toIntOrNull() ?: 0
      Text(
        "${MONTHS[chosen - 1]} ${day.ifEmpty { "__" }}",
        style = MaterialTheme.typography.headlineMedium.merge(MoneyTextStyle),
      )
      Spacer(Modifier.height(Space.S.dp))
      NumberPad(
        modifier = Modifier.weight(1f),
        ready = RewardsInput.isBirthday(chosen, typed),
        onDigit = { key ->
          if (day.length < 2) day += key
          actions.touch()
        },
        onDelete = {
          day = day.dropLast(1)
          actions.touch()
        },
        onDone = { actions.submitBirthday(chosen, typed) },
      )
    }

    Spacer(Modifier.height(Space.S.dp))
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
      if (chosen != null) {
        QuietButton("Change month") {
          month = null
          day = ""
          actions.touch()
        }
      } else {
        Spacer(Modifier.width(Space.S.dp))
      }
      QuietButton("Skip", muted = true, onClick = actions::skipBirthday)
    }
  }
}

/**
 * Permission to send offers.
 *
 * Asked outright and answered by the customer's own tap, because a marketing
 * message may only go to someone who said yes, and "they gave us their number
 * for points" is not that. The whole of what they were shown goes back with
 * the answer, so the record says what was agreed to and not only that it was.
 *
 * Yes is the large button and no is the quiet one, but no is always there,
 * always one tap, and costs them nothing: they keep their points either way,
 * which the small print says in so many words.
 */
@Composable
private fun OffersQuestion(channel: OffersChannel, actions: RewardsActions) {
  val text = channel == OffersChannel.Sms
  val question = if (text) "Want deals by text?" else "Want deals by email?"
  val promise = "We only send real deals. No spam and we never share your information."
  val terms =
    if (text) {
      "Tapping Yes means we may send marketing texts to this number. " +
        "Message and data rates may apply. Reply STOP to end. Not a condition of purchase."
    } else {
      "Tapping Yes means we may send marketing emails to this address. Unsubscribe anytime."
    }
  val wording = "$question $promise $terms"

  Column(horizontalAlignment = Alignment.CenterHorizontally) {
    Icon(Icons.Default.LocalOffer, null, tint = BrandOrange, modifier = Modifier.size(40.dp))
    Spacer(Modifier.height(Space.S.dp))
    Text(question, style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
    Spacer(Modifier.height(Space.S.dp))
    Text(
      promise,
      style = MaterialTheme.typography.bodyLarge,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
      textAlign = TextAlign.Center,
    )
    Spacer(Modifier.height(Space.L.dp))
    MainButton("Yes, send me deals") { actions.answerOffers(true, wording) }
    Spacer(Modifier.height(Space.S.dp))
    QuietButton("No thanks", muted = true) { actions.answerOffers(false, wording) }
    Spacer(Modifier.height(Space.M.dp))
    Text(
      terms,
      style = MaterialTheme.typography.labelMedium,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
      textAlign = TextAlign.Center,
    )
  }
}

// ------------------------------------------------------------- where they stand

/**
 * Signed in.
 *
 * A first name and a balance. The balance is shown only when the register
 * was told one and the program is running: a customer the cashier attached
 * from their own side arrives with no balance, and "0 points" would be a
 * guess presented as a fact.
 *
 * "Not you?" is the answer to the one thing that can go wrong here that the
 * customer can see and the cashier cannot: the person before them signed in
 * and left, or somebody typed their number.
 */
@Composable
private fun MemberWelcome(member: RewardsMember, actions: RewardsActions) {
  val greeting = when {
    member.joined -> "Welcome to rewards"
    member.firstName != null -> "Welcome back, ${member.firstName}"
    else -> "Welcome back"
  }
  Column(horizontalAlignment = Alignment.CenterHorizontally) {
    Icon(
      Icons.Default.CheckCircle,
      null,
      tint = MaterialTheme.colorScheme.tertiary,
      modifier = Modifier.size(56.dp),
    )
    Spacer(Modifier.height(Space.M.dp))
    Text(greeting, style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)

    val points = member.points
    if (points != null && member.programActive) {
      Spacer(Modifier.height(Space.M.dp))
      Text("$points", style = MaterialTheme.typography.displayMedium.merge(MoneyTextStyle))
      Text(
        if (points == 1) "point" else "points",
        style = MaterialTheme.typography.titleMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
      member.worth?.let {
        Text(
          "Worth $${it.toMajorString()} in rewards",
          style = MaterialTheme.typography.bodyLarge,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
      }
    } else {
      Text(
        "You're signed in for this visit.",
        style = MaterialTheme.typography.bodyLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        textAlign = TextAlign.Center,
      )
    }
    Spacer(Modifier.height(Space.L.dp))
    QuietButton("Not you?", muted = true, onClick = actions::notMe)
  }
}

/** No sale can be rung, so there is nothing to sign in to. Says what this side is for. */
@Composable
private fun RewardsResting() {
  Column(horizontalAlignment = Alignment.CenterHorizontally) {
    Icon(
      Icons.Default.CardGiftcard,
      null,
      tint = BrandOrange.copy(alpha = 0.5f),
      modifier = Modifier.size(52.dp),
    )
    Spacer(Modifier.height(Space.M.dp))
    Text("Rewards", style = MaterialTheme.typography.titleLarge)
    Text(
      "Ask about our rewards program",
      style = MaterialTheme.typography.bodyLarge,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
      textAlign = TextAlign.Center,
    )
  }
}

/** They said no thanks. The keypad is one tap away and is not pushed at them again. */
@Composable
private fun RewardsDeclined(actions: RewardsActions) {
  Column(horizontalAlignment = Alignment.CenterHorizontally) {
    Icon(
      Icons.Default.CardGiftcard,
      null,
      tint = BrandOrange.copy(alpha = 0.5f),
      modifier = Modifier.size(52.dp),
    )
    Spacer(Modifier.height(Space.M.dp))
    Text("Rewards", style = MaterialTheme.typography.titleLarge)
    Text(
      "Earn points every time you shop",
      style = MaterialTheme.typography.bodyLarge,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
      textAlign = TextAlign.Center,
    )
    Spacer(Modifier.height(Space.L.dp))
    OutlinedButton(
      onClick = actions::reopen,
      modifier = Modifier.fillMaxWidth().height(Touch.MIN.dp),
      shape = RoundedCornerShape(6.dp),
    ) {
      Text("Sign in or join", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
    }
  }
}

@Composable
private fun RewardsUnavailable(message: String, actions: RewardsActions) {
  Column(horizontalAlignment = Alignment.CenterHorizontally) {
    Text(message, style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
    Spacer(Modifier.height(Space.L.dp))
    QuietButton("Try again", onClick = actions::reopen)
  }
}

@Composable
private fun RewardsMessage(text: String, icon: @Composable () -> Unit) {
  Column(horizontalAlignment = Alignment.CenterHorizontally) {
    icon()
    Spacer(Modifier.height(Space.M.dp))
    Text(text, style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
  }
}

// ------------------------------------------------------------------- the parts

/** The one thing a panel is asking for. */
@Composable
private fun MainButton(label: String, onClick: () -> Unit) {
  Button(
    onClick = onClick,
    modifier = Modifier.fillMaxWidth().height(Touch.PRIMARY.dp),
    shape = RoundedCornerShape(6.dp),
  ) {
    Text(
      label,
      style = MaterialTheme.typography.titleLarge,
      fontWeight = FontWeight.SemiBold,
      maxLines = 1,
      softWrap = false,
    )
  }
}

/**
 * Everything else a panel offers. [muted] is for the way out (no thanks,
 * skip, not you), which is always present and never the loudest thing there.
 */
@Composable
private fun QuietButton(label: String, muted: Boolean = false, onClick: () -> Unit) {
  TextButton(
    onClick = onClick,
    modifier = Modifier.height(Touch.MIN.dp),
    colors = ButtonDefaults.textButtonColors(
      contentColor = if (muted) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.primary,
    ),
  ) {
    Text(label, style = MaterialTheme.typography.titleMedium, maxLines = 1, softWrap = false)
  }
}

/**
 * One key.
 *
 * Sized by whoever places it, never by itself: on a keypad it takes a third
 * of the column, on the keyboard a tenth of the screen. Operated by a
 * stranger who will use it once, so it is as large as its row allows and the
 * whole of it is the target.
 */
@Composable
private fun PadKey(
  label: String,
  modifier: Modifier = Modifier,
  accent: Boolean = false,
  muted: Boolean = false,
  enabled: Boolean = true,
  textStyle: TextStyle = MaterialTheme.typography.displaySmall,
  corner: Int = Corner.CARD,
  onClick: () -> Unit,
) {
  Box(
    modifier
      .clip(RoundedCornerShape(corner.dp))
      .background(
        when {
          accent -> BrandOrange
          !enabled -> MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f)
          muted -> MaterialTheme.colorScheme.surfaceVariant
          else -> MaterialTheme.colorScheme.surface
        },
      )
      .clickable(enabled = enabled, role = Role.Button, onClick = onClick),
    contentAlignment = Alignment.Center,
  ) {
    if (label == DELETE) {
      Icon(Icons.AutoMirrored.Filled.Backspace, "Delete", tint = MaterialTheme.colorScheme.onSurfaceVariant)
    } else {
      Text(
        label,
        style = textStyle,
        color = when {
          accent -> Color.White
          !enabled -> MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f)
          else -> MaterialTheme.colorScheme.onSurface
        },
        maxLines = 1,
        softWrap = false,
      )
    }
  }
}

private const val DELETE = "⌫"
private const val DONE = "✓"

/** How long a half typed phone number may sit before it is wiped. */
private const val ABANDONED_ENTRY_MS = 30_000L

/** Longer than any address a person types at a counter, shorter than the server's limit. */
private const val EMAIL_MAX = 64

/** Past this many characters the field shows the address in the smaller size. */
private const val EMAIL_LARGE_UNTIL = 40

private const val EMAIL_CONTINUE_WIDTH = 220

private val MONTHS = listOf(
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
)

/** Lowercase throughout: an address is stored lowercase, so there is no shift key to explain. */
private val EMAIL_ROWS = listOf(
  listOf("1", "2", "3", "4", "5", "6", "7", "8", "9", "0"),
  listOf("q", "w", "e", "r", "t", "y", "u", "i", "o", "p"),
  listOf("a", "s", "d", "f", "g", "h", "j", "k", "l", "@"),
  listOf("z", "x", "c", "v", "b", "n", "m", ".", "_", "-", DELETE),
)

/** The endings most addresses have. One tap instead of ten, and no typo in the part that matters most. */
private val EMAIL_ENDINGS = listOf("@gmail.com", "@yahoo.com", "@icloud.com", "@outlook.com", "@hotmail.com", ".com")

/** (254) 555-0137, filled in as they type. Grouping is the only help a ten digit number needs. */
private fun typedPhone(digits: String): String {
  if (digits.isEmpty()) return "(___) ___-____"
  val padded = digits.padEnd(10, '_')
  return "(${padded.take(3)}) ${padded.drop(3).take(3)}-${padded.drop(6).take(4)}"
}
