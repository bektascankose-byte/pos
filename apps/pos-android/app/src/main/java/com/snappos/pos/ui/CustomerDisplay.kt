package com.snappos.pos.ui

import android.app.Presentation
import android.content.Context
import android.content.ContextWrapper
import android.hardware.display.DisplayManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Display
import androidx.activity.ComponentActivity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.lifecycle.setViewTreeViewModelStoreOwner
import androidx.savedstate.setViewTreeSavedStateRegistryOwner
import com.snappos.domain.Cart

/**
 * What the customer's screen is showing right now.
 *
 * A snapshot passed across rather than a second view model. The customer's
 * screen is a window onto this sale and has no state of its own worth keeping:
 * anything it could forget, the register already knows, and two sources of
 * truth for one cart is how the two screens end up disagreeing about a total
 * in front of the person paying it.
 */
data class CustomerScreenState(
  val storeName: String = "",
  val cart: Cart = Cart.EMPTY,
  val customerName: String? = null,
  val loyalty: LoyaltyState = LoyaltyState.Closed,
)

sealed interface LoyaltyState {
  /** Nothing offered: mid-sale, or already attached. */
  data object Closed : LoyaltyState
  data object Offered : LoyaltyState
  data object Entering : LoyaltyState
  data object Searching : LoyaltyState
  data class Welcome(val name: String) : LoyaltyState
  /** The number is not on file. The cashier finishes the sign-up. */
  data class NotOnFile(val phone: String) : LoyaltyState
  data class Unavailable(val reason: String) : LoyaltyState
}

/**
 * Drives the customer-facing screen, when there is one.
 *
 * Android exposes a second screen as a *presentation display*, and this puts a
 * `Presentation` on the first one it finds. If the register has no second
 * screen, or the one it has is a serial line display rather than an Android
 * display, nothing here runs and nothing is shown -- it must never be the
 * reason the till itself fails to draw.
 *
 * The display is watched rather than looked up once: a customer screen on this
 * hardware can come and go with a cable, and a register that has to be
 * restarted to notice is a register the shop restarts during a queue.
 */
@Composable
fun CustomerDisplayHost(
  state: CustomerScreenState,
  onPhoneEntered: (String) -> Unit,
  onDismissLoyalty: () -> Unit,
) {
  val context = LocalContext.current
  val activity = remember(context) { context.findActivity() } ?: return
  val displays = remember(context) { context.getSystemService(DisplayManager::class.java) }

  var display by remember { mutableStateOf<Display?>(null) }
  DisposableEffect(displays) {
    fun pick() {
      display = displays?.getDisplays(DisplayManager.DISPLAY_CATEGORY_PRESENTATION)?.firstOrNull()
    }
    pick()
    val listener = object : DisplayManager.DisplayListener {
      override fun onDisplayAdded(displayId: Int) = pick()
      override fun onDisplayRemoved(displayId: Int) = pick()
      override fun onDisplayChanged(displayId: Int) = pick()
    }
    displays?.registerDisplayListener(listener, Handler(Looper.getMainLooper()))
    onDispose { displays?.unregisterDisplayListener(listener) }
  }

  // The presentation is built once per display and then fed. Rebuilding it on
  // every cart change would blink the customer's screen on every scan.
  val live = remember { mutableStateOf(state) }
  SideEffect { live.value = state }
  val phone = rememberUpdatedState(onPhoneEntered)
  val dismiss = rememberUpdatedState(onDismissLoyalty)

  val target = display
  DisposableEffect(target) {
    val presentation = target?.let { CustomerPresentation(activity, it, live, phone, dismiss) }
    // A second screen that is unplugged mid-show throws rather than returning,
    // and that must not take the till down with it.
    runCatching { presentation?.show() }
    onDispose { runCatching { presentation?.dismiss() } }
  }
}

private class CustomerPresentation(
  private val activity: ComponentActivity,
  display: Display,
  private val state: State<CustomerScreenState>,
  private val onPhone: State<(String) -> Unit>,
  private val onDismiss: State<() -> Unit>,
) : Presentation(activity, display) {

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val view = ComposeView(context).apply {
      // A Presentation window has no view-tree owners of its own, so it borrows
      // the register's. They share a lifetime by construction: this window only
      // exists while that activity is composing it.
      setViewTreeLifecycleOwner(activity)
      setViewTreeViewModelStoreOwner(activity)
      setViewTreeSavedStateRegistryOwner(activity)
      setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnViewTreeLifecycleDestroyed)
      setContent {
        SnapPosTheme {
          CustomerScreen(
            state = state.value,
            onPhoneEntered = { onPhone.value(it) },
            onDismiss = { onDismiss.value() },
          )
        }
      }
    }
    setContentView(view)
  }
}

private tailrec fun Context.findActivity(): ComponentActivity? = when (this) {
  is ComponentActivity -> this
  is ContextWrapper -> baseContext.findActivity()
  else -> null
}
