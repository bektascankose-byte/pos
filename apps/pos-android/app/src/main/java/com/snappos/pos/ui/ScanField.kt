package com.snappos.pos.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.PressInteraction
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Keyboard
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

private const val LF = '\n'
private const val CR = '\r'

/**
 * The scan field. One field, two jobs: scanner input and search.
 *
 * A cashier looking something up and a cashier scanning it are doing the same
 * job and should not have to pick a mode first. It holds focus from launch, so
 * a scan works the instant the app is open with no tap — a hardware scanner
 * types like a keyboard, and if nothing holds focus those characters go
 * nowhere.
 *
 * **Submission does not go through the IME action**, and that is the whole
 * point of this file. Tested on a Samsung device, the IME clears the field
 * *before* firing its Done action, so an `onDone` handler that reads the
 * field's current value receives an empty string and silently does nothing —
 * the field blanks, the search resets, and no item reaches the cart. It looks
 * exactly like a scan that did not register.
 *
 * So there are three paths, in order of reliability:
 *
 *   1. `onPreviewKeyEvent` catches the real Enter key, before the IME can touch
 *      the field. This is what a hardware scanner actually produces and it is
 *      the authoritative path.
 *   2. `onValueChange` catches a terminator that arrives as text rather than as
 *      a key event, which some scanners in keyboard-wedge mode do.
 *   3. `keyboardActions` remains for on-screen typing, and tolerates the empty
 *      value rather than depending on it.
 *
 * Enter does not decide what the text *was*. It hands it to `onSubmit`, and the
 * register works out from the catalog whether that was a barcode or a search
 * the cashier has finished typing. The field only empties itself, ready for the
 * next scan; a finished search lives on as the chip underneath.
 *
 * **The on-screen keyboard comes up only when a person asks for it.** It used
 * to be hidden once, immediately after `requestFocus()`, which reads correctly
 * and does not work: Compose *posts* the show when focus arrives, so a hide in
 * the same frame runs first and the keyboard appears a frame later anyway. On a
 * 1080p till it then covers half the product grid and will not go away,
 * because the field takes focus again after every scan.
 *
 * The hide is driven by whether the keyboard is *actually* on screen rather
 * than by when focus changed. Guessing at the timing does not work -- the show
 * is posted, and hiding a fixed number of frames later is a race that this
 * till wins often enough to be annoying and loses often enough to be broken.
 * Watching `isImeVisible` needs no timing at all: whenever the keyboard is up
 * and nobody asked for it, it goes down.
 *
 * "Nobody asked for it" is the part that was wrong. Only the keyboard button
 * counted as asking, so a cashier who did the obvious thing -- tapped the field
 * to type -- watched the keyboard rise and drop again before they could press
 * a key. **A finger on the field is now asking too**, and the request holds
 * until the cashier presses Enter, clears the search, or moves on to a folder.
 * A scanner never touches the screen, so it still never raises the keyboard,
 * which is exactly the distinction this field needs: a press on the glass is a
 * person, keystrokes without one are a scanner.
 *
 * **Autocorrect is off.** "Razz" and "Foger" are not words a keyboard knows,
 * and it was rewriting product words between the cashier's finger and the
 * search, so the search looked for something nobody typed. Android's own
 * keyboard does not autocorrect a single-line field unless the field asks it
 * to, and Compose asks by default; this one no longer does.
 *
 * **The microphone beside the keyboard button searches by voice**, when the
 * till has a speech recogniser to hear with (see [VoiceSearch]). What the
 * cashier says fills the field as they say it and searches as it goes; a
 * second and a half after they stop, it is handed to the register, which
 * commits the first of the recogniser's guesses that matches a product.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ScanField(
  /** Changes whenever the search is cleared from outside the field. The field empties when it does. */
  clearSignal: Int,
  onQueryChange: (String) -> Unit,
  onSubmit: (String) -> Unit,
  /** What the recogniser heard, best guess first, once the cashier stopped talking. */
  onHeard: (List<String>) -> Unit,
  /** Something about voice search went wrong in a way the cashier should be told. */
  onVoiceProblem: (String) -> Unit,
) {
  val focus = remember { FocusRequester() }
  val keyboard = LocalSoftwareKeyboardController.current
  val interactions = remember { MutableInteractionSource() }
  val context = LocalContext.current
  val voice = rememberVoiceSearch()
  val heard by rememberUpdatedState(onHeard)
  val problem by rememberUpdatedState(onVoiceProblem)
  val queryChanged by rememberUpdatedState(onQueryChange)
  var text by remember { mutableStateOf("") }
  var focused by remember { mutableStateOf(false) }
  // Set by a finger on the field or the keyboard button. Held until Enter.
  var wantsKeyboard by remember { mutableStateOf(false) }

  /**
   * Listen, showing the words in the field as they arrive so the grid searches
   * along with the cashier, then hand every guess over once they stop.
   */
  fun listen() {
    wantsKeyboard = false
    text = ""
    voice.start(
      onPartial = { words ->
        text = words
        queryChanged(words)
      },
      onHeard = { guesses ->
        text = ""
        heard(guesses)
      },
      onProblem = { message ->
        text = ""
        queryChanged("")
        problem(message)
      },
    )
  }

  // Android asks the cashier once, the first time the microphone is tapped.
  val askForMicrophone = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
    if (granted) {
      listen()
    } else {
      problem("Voice search needs the microphone. Allow it for SnapPOS in Settings, Apps.")
    }
  }

  fun toggleVoice() {
    when {
      voice.listening -> {
        voice.cancel()
        text = ""
        queryChanged("")
      }
      context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED -> listen()
      else -> askForMicrophone.launch(Manifest.permission.RECORD_AUDIO)
    }
  }

  /**
   * Hand the text over and reset for the next scan.
   *
   * Takes the value as a parameter rather than reading `text`, because by the
   * time path 3 fires the field may already have been cleared. Always calls
   * through, even when empty, so the register can drop a half-typed draft.
   */
  fun submit(value: String) {
    // A scan while listening means the cashier moved on; the scan wins.
    voice.cancel()
    text = ""
    wantsKeyboard = false
    focus.requestFocus()
    onSubmit(value.trim())
  }

  LaunchedEffect(Unit) { focus.requestFocus() }

  // The chip's X, or a folder opened: the field follows the search out.
  LaunchedEffect(clearSignal) {
    text = ""
    wantsKeyboard = false
  }

  // A press on the field is a person, not a scanner. Pressed rather than
  // released, so the request is on record before the keyboard starts rising
  // and the hide below never sees it unasked-for.
  LaunchedEffect(interactions) {
    interactions.interactions.collect {
      // Not while listening: the microphone button sits inside the field, and
      // a press on it must stay a press on the microphone. The way out of
      // listening is the microphone itself, or a scan.
      if (it is PressInteraction.Press && !voice.listening) wantsKeyboard = true
    }
  }

  // Asked for: raise it. Keyed on focus as well, because a tap on a field that
  // had lost focus asks before the field has it back, and a show with nothing
  // focused goes nowhere.
  LaunchedEffect(wantsKeyboard, focused) { if (wantsKeyboard && focused) keyboard?.show() }

  // Not asked for: put it away, however it got there.
  val imeVisible = WindowInsets.isImeVisible
  LaunchedEffect(imeVisible, wantsKeyboard) {
    if (imeVisible && !wantsKeyboard) keyboard?.hide()
  }

  LaunchedEffect(focused) { if (!focused) wantsKeyboard = false }

  OutlinedTextField(
    value = text,
    onValueChange = { incoming ->
      if (incoming.any { it == LF || it == CR }) {
        submit(incoming.filterNot { it == LF || it == CR })
      } else {
        text = incoming
        onQueryChange(incoming)
      }
    },
    modifier = Modifier
      .fillMaxWidth()
      .padding(horizontal = Space.M.dp, vertical = Space.S.dp)
      .focusRequester(focus)
      .onFocusChanged { focused = it.isFocused }
      .onPreviewKeyEvent { event ->
        val isEnter = event.key == Key.Enter || event.key == Key.NumPadEnter
        if (isEnter && event.type == KeyEventType.KeyDown) {
          submit(text)
          true
        } else {
          false
        }
      },
    interactionSource = interactions,
    singleLine = true,
    shape = RoundedCornerShape(14.dp),
    leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
    trailingIcon = {
      Row(verticalAlignment = Alignment.CenterVertically) {
        // Only when there is a recogniser to talk to. A microphone that can
        // only ever say "not available" is worse than no microphone.
        if (voice.available) MicButton(listening = voice.listening, level = voice.level, onClick = { toggleVoice() })
        IconButton(onClick = { wantsKeyboard = true }) {
          Icon(Icons.Default.Keyboard, contentDescription = "Show the keyboard")
        }
      }
    },
    placeholder = {
      Text(if (voice.listening) "Listening. Say the product." else "Scan a barcode, or tap here to search")
    },
    keyboardOptions = KeyboardOptions(
      keyboardType = KeyboardType.Ascii,
      capitalization = KeyboardCapitalization.None,
      autoCorrectEnabled = false,
      imeAction = ImeAction.Search,
    ),
    keyboardActions = KeyboardActions(
      onSearch = { submit(text) },
      onDone = { submit(text) },
    ),
  )
}

/**
 * The search, once it is on screen: the words, how many things they found, and
 * the X that ends it.
 *
 * Clearing goes back to whichever folder the cashier was standing in when they
 * started typing, because a search is a detour from browsing and not a place
 * of its own. It takes the breadcrumb's row while it shows, so the grid below
 * does not jump.
 */
@Composable
fun SearchChip(term: String, count: Int, onClear: () -> Unit) {
  val shape = RoundedCornerShape(Corner.CHIP.dp)
  Row(
    Modifier.fillMaxWidth().padding(horizontal = Space.M.dp, vertical = Space.XS.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Row(
      Modifier
        .height(48.dp)
        .clip(shape)
        .background(BrandOrange.copy(alpha = 0.14f))
        .border(1.dp, BrandOrange.copy(alpha = 0.55f), shape)
        .padding(start = Space.M.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Icon(Icons.Default.Search, contentDescription = null, tint = BrandRed, modifier = Modifier.size(18.dp))
      Spacer(Modifier.width(Space.S.dp))
      Text(
        term,
        style = MaterialTheme.typography.bodyLarge,
        fontWeight = FontWeight.Bold,
        color = BrandRed,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.widthIn(max = 480.dp),
      )
      // The whole right end of the chip is the target, not just the glyph: it
      // is pressed by someone looking at the customer, not at the X.
      IconButton(onClick = onClear, modifier = Modifier.size(48.dp)) {
        Icon(Icons.Default.Close, contentDescription = "Clear search", tint = BrandRed)
      }
    }
    Spacer(Modifier.width(Space.S.dp))
    Text(
      if (count == 1) "1 result" else "$count results",
      style = MaterialTheme.typography.labelMedium,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
  }
}

/**
 * The microphone.
 *
 * Grey when idle, and red while listening, swelling with the sound it hears.
 * The swell is the point: a cashier talking to a till needs to see that it is
 * hearing them, and a red dot that never moves looks the same whether the
 * microphone works or not.
 */
@Composable
private fun MicButton(listening: Boolean, level: Float, onClick: () -> Unit) {
  IconButton(onClick = onClick) {
    Icon(
      Icons.Default.Mic,
      contentDescription = if (listening) "Stop listening" else "Search by voice",
      tint = if (listening) Color.White else MaterialTheme.colorScheme.onSurfaceVariant,
      modifier = if (listening) {
        Modifier
          .scale(1f + level * 0.25f)
          .clip(CircleShape)
          .background(BrandRed)
          .padding(6.dp)
      } else {
        Modifier
      },
    )
  }
}
