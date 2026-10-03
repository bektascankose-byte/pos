package com.snappos.pos.ui

import android.app.Presentation
import android.content.Context
import android.content.ContextWrapper
import android.hardware.display.DisplayManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Display
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.lifecycle.setViewTreeViewModelStoreOwner
import androidx.savedstate.setViewTreeSavedStateRegistryOwner
import com.snappos.domain.Cart
import com.snappos.domain.Money
import com.snappos.sync.CustomerDto

/**
 * What the customer's screen is showing right now.
 *
 * A snapshot passed across rather than a second view model. The customer's
 * screen is a window onto this sale and has no state of its own worth keeping:
 * anything it could forget, the register already knows, and two sources of
 * truth for one cart is how the two screens end up disagreeing about a total
 * in front of the person paying it.
 *
 * The one exception is [rewards], which comes from [RewardsViewModel]. Where a
 * customer is in signing in is theirs alone and the register has no use for
 * it; who ends up attached to the sale still lives on the register.
 */
data class CustomerScreenState(
  val storeName: String = "",
  val cart: Cart = Cart.EMPTY,
  val customerName: String? = null,
  val rewards: RewardsPanel = RewardsPanel.Resting,
  /** The sale just paid for. Shown in place of an empty basket until the next one starts. */
  val completed: CompletedSale? = null,
)

/**
 * What the customer is told once they have paid: what it came to and what
 * they are owed back. The change is the one number on this screen a customer
 * acts on, so it is carried here as the receipt has it rather than worked out
 * a second time.
 */
data class CompletedSale(val total: Money, val change: Money)

/**
 * The customer's screen for this register.
 *
 * Reads the same view model the cashier's screen does and passes across only
 * what a customer should see. Nothing is shown outside a sale: a locked till,
 * a closed drawer and a refund all leave the basket side empty, because a
 * half built refund or the last cashier's cart is not the customer's business.
 *
 * The customer is greeted by name only. The cashier's side falls back to a
 * phone number or an email when there is no name, and neither belongs on a
 * screen the next person in the queue can read.
 *
 * It is also where the rewards side is joined to the register: the customer
 * signing in attaches them to the sale through the register's own
 * `attachCustomer`, the same call the cashier's customer dialog makes, so
 * there is one way onto a sale and the cashier sees it happen.
 */
@Composable
fun RegisterCustomerDisplay(viewModel: RegisterViewModel, rewards: RewardsViewModel = hiltViewModel()) {
  val state by viewModel.state.collectAsStateWithLifecycle()
  val panel by rewards.panel.collectAsStateWithLifecycle()
  val selling = state.stage == RegisterStage.Selling

  // The receipt on the cashier's screen is this sale's only while its number
  // is still the last one rung. A reprint from the day's history puts an old
  // receipt up, and thanking today's customer for somebody else's sale would
  // show them a total that is not theirs.
  val receipt = state.lastReceipt
  val completed = receipt
    ?.takeIf { selling && state.showingReceipt && it.receiptNo == state.lastReceiptNo }
    ?.let { CompletedSale(total = it.total, change = it.change) }

  val attached = state.attachedCustomer
  val customerName = attached
    ?.takeIf { selling }
    ?.let { customer ->
      listOfNotNull(customer.first_name, customer.last_name)
        .map { it.trim() }
        .filter { it.isNotEmpty() }
        .joinToString(" ")
        .ifEmpty { null }
    }

  val link = remember(viewModel) {
    object : RegisterLink {
      override fun attach(customer: CustomerDto) = viewModel.attachCustomer(customer)
      override fun detach() = viewModel.detachCustomer()
    }
  }
  // The rewards side is told the whole picture whenever any part of it
  // changes. The receipt number is how it knows a sale completed: it is set
  // by a sale committing and by nothing else, which the sale id is not (a
  // reprint from history changes that too).
  val cartEmpty = state.cart.isEmpty
  val lastReceiptNo = state.lastReceiptNo
  LaunchedEffect(link, selling, attached?.id, cartEmpty, lastReceiptNo) {
    rewards.connect(link)
    rewards.onRegister(
      selling = selling,
      attached = attached,
      cartEmpty = cartEmpty,
      lastReceiptNo = lastReceiptNo,
    )
  }

  CustomerDisplayHost(
    state = CustomerScreenState(
      storeName = state.storeName,
      cart = if (selling) state.cart else Cart.EMPTY,
      customerName = customerName,
      rewards = panel,
      completed = completed,
    ),
    actions = rewards,
  )
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
fun CustomerDisplayHost(state: CustomerScreenState, actions: RewardsActions) {
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

  // Up only while the register itself is on screen. Android does not take a
  // presentation down when its activity goes to the background, and this till
  // is shared: left up, it would sit over the other till app's own customer
  // screen while that app is ringing a sale.
  //
  // Shown and dismissed from the lifecycle callback itself, not from state the
  // callback sets, so taking the screen down never waits on a recomposition
  // of an activity that has just been stopped.
  val target = display
  DisposableEffect(target, activity, actions) {
    val main = Handler(Looper.getMainLooper())
    var disposed = false
    var presentation: CustomerPresentation? = null
    fun show() {
      if (disposed || presentation != null || target == null) return
      if (!activity.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) return
      val next = CustomerPresentation(activity, target, live, actions)
      // Android takes a presentation down by itself when its display changes
      // size or rotation. Nothing else would put it back until the register
      // next left the screen and returned, and until then the customer would
      // be looking at a copy of the cashier's side. So a dismissal this code
      // did not ask for is answered with a fresh one, a moment later so that
      // a display still settling is not chased.
      next.setOnDismissListener {
        if (presentation === next) {
          presentation = null
          main.postDelayed({ show() }, 500)
        }
      }
      // A second screen that is unplugged mid-show throws rather than
      // returning, and that must not take the till down with it.
      if (runCatching { next.show() }.isSuccess) presentation = next
    }
    fun hide() {
      // Forgotten before it is dismissed, so the listener above can tell this
      // from a dismissal Android made and does not put it straight back.
      val showing = presentation
      presentation = null
      showing?.let { runCatching { it.dismiss() } }
    }
    // An observer added to a lifecycle that has already started is sent
    // ON_START straight away, so this also covers the first show.
    val observer = LifecycleEventObserver { _, event ->
      when (event) {
        Lifecycle.Event.ON_START -> show()
        Lifecycle.Event.ON_STOP -> hide()
        else -> Unit
      }
    }
    activity.lifecycle.addObserver(observer)
    onDispose {
      disposed = true
      main.removeCallbacksAndMessages(null)
      activity.lifecycle.removeObserver(observer)
      hide()
    }
  }
}

private class CustomerPresentation(
  private val activity: ComponentActivity,
  display: Display,
  private val state: State<CustomerScreenState>,
  private val actions: RewardsActions,
) : Presentation(activity, display) {

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // Touchable, but never the window the keyboard is talking to. The barcode
    // scanner on this till is a keyboard, and Android gives the keys to
    // whichever screen was touched last: without this, a customer tapping
    // their screen would take the scanner away from the cashier until the
    // cashier touched theirs again. Everything on this screen is a button,
    // the email keyboard included, so it has no use for the keys.
    window?.addFlags(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE)
    val view = ComposeView(context).apply {
      // A Presentation window has no view-tree owners of its own, so it borrows
      // the register's. They share a lifetime by construction: this window only
      // exists while that activity is composing it.
      setViewTreeLifecycleOwner(activity)
      setViewTreeViewModelStoreOwner(activity)
      setViewTreeSavedStateRegistryOwner(activity)
      // The window is taken down every time the register leaves the screen and
      // a new one is built when it comes back, so the composition goes with
      // its window. Tied to the activity instead, each trip to the other till
      // app would leave one more composition running behind a screen nobody
      // can see.
      setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnDetachedFromWindow)
      setContent {
        SnapPosTheme {
          CustomerScreen(state = state.value, actions = actions)
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
