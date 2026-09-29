package com.snappos.pos.ui

import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.Icon
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Keyboard
import androidx.compose.material.icons.filled.Search
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
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
 * **The on-screen keyboard is never raised on its own.** It used to be hidden
 * once, immediately after `requestFocus()`, which reads correctly and does not
 * work: Compose *posts* the show when focus arrives, so a hide in the same
 * frame runs first and the keyboard appears a frame later anyway. On a 1080p
 * till it then covers half the product grid and will not go away, because the
 * field takes focus again after every scan. The hide now runs on the next few
 * frames as well, which is what actually beats the posted show.
 *
 * A cashier who wants to type has the keyboard button in the field. That is
 * deliberate: a register is driven by a scanner, the IME is the exception, and
 * an exception should be asked for rather than dismissed over and over.
 *
 * The hide is driven by whether the keyboard is *actually* on screen rather
 * than by when focus changed. Guessing at the timing does not work -- the show
 * is posted, and hiding a fixed number of frames later is a race that this
 * till wins often enough to be annoying and loses often enough to be broken.
 * Watching `isImeVisible` needs no timing at all: whenever the keyboard is up
 * and nobody asked for it, it goes down.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ScanField(onQueryChange: (String) -> Unit, onSubmit: (String) -> Unit) {
  val focus = remember { FocusRequester() }
  val keyboard = LocalSoftwareKeyboardController.current
  var text by remember { mutableStateOf("") }
  var focused by remember { mutableStateOf(false) }
  // Set only by the keyboard button, and cleared as soon as it is honoured.
  var wantsKeyboard by remember { mutableStateOf(false) }

  /**
   * Submit and reset for the next scan.
   *
   * Takes the value as a parameter rather than reading `text`, because by the
   * time path 3 fires the field may already have been cleared.
   */
  fun submit(value: String) {
    val barcode = value.trim()
    text = ""
    onQueryChange("")
    wantsKeyboard = false
    focus.requestFocus()
    if (barcode.isNotEmpty()) onSubmit(barcode)
  }

  LaunchedEffect(Unit) { focus.requestFocus() }

  // Asked for by the button: raise it, and leave it alone until the cashier
  // scans something or moves on.
  LaunchedEffect(wantsKeyboard) { if (wantsKeyboard) keyboard?.show() }

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
    singleLine = true,
    shape = RoundedCornerShape(14.dp),
    leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
    trailingIcon = {
      IconButton(onClick = { wantsKeyboard = true }) {
        Icon(Icons.Default.Keyboard, contentDescription = "Show the keyboard")
      }
    },
    placeholder = { Text("Scan barcode or search products") },
    keyboardOptions = KeyboardOptions(
      keyboardType = KeyboardType.Ascii,
      imeAction = ImeAction.Done,
    ),
    keyboardActions = KeyboardActions(onDone = { submit(text) }),
  )
}
