package com.snappos.pos.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.snappos.domain.Money
import com.snappos.domain.RewardsInput
import com.snappos.sync.CustomerDto
import com.snappos.sync.RewardsContactRequest
import com.snappos.sync.RewardsFailure
import com.snappos.sync.RewardsGateway
import com.snappos.sync.RewardsMemberDto
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/** The contact a customer typed, and how it is read back to them. */
sealed interface RewardsContact {
  val shown: String

  data class Phone(val e164: String) : RewardsContact {
    override val shown: String get() = RewardsInput.formatPhone(e164)
  }

  data class Email(val address: String) : RewardsContact {
    override val shown: String get() = address
  }
}

enum class OffersChannel(val wire: String) {
  Sms("sms"),
  Email("email"),
}

/**
 * A signed in member, as their screen shows them.
 *
 * [points] is null for a customer the cashier attached from their own side:
 * the register knows who it is, not what they have. [self] marks a customer
 * who signed in on this screen, which is the only kind the screen will sign
 * back out by itself.
 */
data class RewardsMember(
  val customer: CustomerDto,
  val firstName: String?,
  val points: Int?,
  val worth: Money?,
  val programActive: Boolean,
  val joined: Boolean,
  val self: Boolean,
)

/** What the rewards side of the customer's screen is showing. */
sealed interface RewardsPanel {
  /** No sale can be rung: the till is locked, closed or on a refund. Nothing to tap. */
  data object Resting : RewardsPanel

  data class EnterPhone(val problem: String? = null) : RewardsPanel
  data class EnterEmail(val problem: String? = null) : RewardsPanel
  data object Working : RewardsPanel

  /** The contact is not a member yet. Joining is theirs to choose, not assumed. */
  data class ConfirmJoin(val contact: RewardsContact) : RewardsPanel

  data class AskBirthday(val member: RewardsMember) : RewardsPanel
  data class AskOffers(val member: RewardsMember, val channel: OffersChannel) : RewardsPanel
  data class SignedIn(val member: RewardsMember) : RewardsPanel

  /** They said no thanks. One button brings the keypad back. */
  data object Declined : RewardsPanel

  data class Unavailable(val message: String) : RewardsPanel
}

/** Everything a customer can do on the rewards side. */
interface RewardsActions {
  /** A key was pressed. Keeps a half typed entry from timing out mid word. */
  fun touch()
  fun submitPhone(digits: String)
  fun submitEmail(address: String)
  fun useEmail()
  fun usePhone()
  fun confirmJoin()
  fun fixContact()
  fun submitBirthday(month: Int, day: Int)
  fun skipBirthday()

  /** [wording] is the question exactly as it was on the screen. */
  fun answerOffers(granted: Boolean, wording: String)
  fun notMe()
  fun decline()
  fun reopen()
}

/** The two things the rewards side does to the sale itself. */
interface RegisterLink {
  fun attach(customer: CustomerDto)
  fun detach()
}

/**
 * Drives the rewards side of the customer's screen.
 *
 * The register stays the only authority on the sale: who is attached to it
 * lives in [RegisterViewModel], and this reaches it through [RegisterLink]
 * and hears back through [onRegister]. What lives here is only where the
 * customer is in their own conversation with the screen, which the cashier's
 * side has no use for.
 *
 * Two things shape most of it.
 *
 * **A sale can finish underneath the customer.** A quick cashier takes the
 * cash while the customer is still choosing a birthday month. The questions
 * are about the member, not the sale, so they stay up and are still saved.
 * But a lookup or a join that began during one sale must not attach its
 * customer to the next one, which by then belongs to somebody else. Every
 * sign in remembers which sale it started in ([saleEpoch]) and only attaches
 * to that one.
 *
 * **Customers walk away.** A half typed email, a "join?" showing somebody's
 * number, a member who signed in and left without buying: each would greet
 * the next person in the queue. So everything but the bare keypad goes back
 * to the keypad after a spell with no touch, and a member who signed in here
 * is signed out again if no sale starts.
 */
@HiltViewModel
class RewardsViewModel @Inject constructor(
  private val gateway: RewardsGateway,
) : ViewModel(), RewardsActions {

  private val _panel = MutableStateFlow<RewardsPanel>(RewardsPanel.Resting)
  val panel: StateFlow<RewardsPanel> = _panel

  private var link: RegisterLink? = null
  private var selling = false
  private var cartEmpty = true

  /** Who the register has on the sale, as far as this side knows. */
  private var attachedId: String? = null

  /** Bumped every time a sale completes. */
  private var saleEpoch = 0
  private var lastReceiptNo: String? = null

  /** The contact being joined, and the sale it was typed during. */
  private var joining: Pair<RewardsContact, Int>? = null

  /** The member being asked questions, and which are still to ask. */
  private var asking: Asking? = null

  private var request: Job? = null
  private var idle: Job? = null

  private data class Asking(val member: RewardsMember, val birthday: Boolean, val offers: OffersChannel?)

  fun connect(register: RegisterLink) {
    link = register
  }

  /**
   * The register changed: its stage, who is attached, the cart, or the last
   * sale it completed. Called with the whole picture each time rather than
   * as separate events, so there is no order to get wrong.
   */
  fun onRegister(selling: Boolean, attached: CustomerDto?, cartEmpty: Boolean, lastReceiptNo: String?) {
    val saleDone = lastReceiptNo != null && lastReceiptNo != this.lastReceiptNo
    if (saleDone) saleEpoch++
    this.lastReceiptNo = lastReceiptNo
    this.selling = selling
    this.cartEmpty = cartEmpty
    attachedId = attached?.id

    if (!selling) {
      request?.cancel()
      joining = null
      asking = null
      show(RewardsPanel.Resting)
      return
    }

    val current = _panel.value
    val next = when (current) {
      RewardsPanel.Resting -> home(attached)
      // Mid conversation: left alone whatever the register does. Finishing
      // is what works out where they stand afterwards.
      is RewardsPanel.AskBirthday, is RewardsPanel.AskOffers,
      is RewardsPanel.ConfirmJoin, RewardsPanel.Working -> current
      is RewardsPanel.SignedIn -> when {
        attached == null -> RewardsPanel.EnterPhone()
        attached.id != current.member.customer.id -> RewardsPanel.SignedIn(attached.asAttachedByCashier())
        else -> current
      }
      // Typing an email is not interrupted by a sale completing either, but a
      // customer the cashier has just attached replaces it: they are signed in.
      is RewardsPanel.EnterEmail -> if (attached != null) home(attached) else current
      is RewardsPanel.EnterPhone -> if (attached != null) home(attached) else current
      RewardsPanel.Declined, is RewardsPanel.Unavailable ->
        if (attached != null || saleDone) home(attached) else current
    }
    if (next != current) show(next) else restartIdle()
  }

  override fun touch() = restartIdle()

  override fun submitPhone(digits: String) {
    val e164 = RewardsInput.phoneToE164(digits)
    if (e164 == null) {
      show(RewardsPanel.EnterPhone(problem = "Check the number and try again."))
      return
    }
    lookUp(RewardsContact.Phone(e164))
  }

  override fun submitEmail(address: String) {
    val clean = address.trim().lowercase()
    if (!RewardsInput.isEmail(clean)) {
      show(RewardsPanel.EnterEmail(problem = "Check the email and try again."))
      return
    }
    lookUp(RewardsContact.Email(clean))
  }

  override fun useEmail() = show(RewardsPanel.EnterEmail())

  override fun usePhone() = show(RewardsPanel.EnterPhone())

  override fun confirmJoin() {
    val (contact, epoch) = joining ?: return
    if (_panel.value !is RewardsPanel.ConfirmJoin) return
    show(RewardsPanel.Working)
    request?.cancel()
    request = viewModelScope.launch {
      val result = gateway.join(contact.asRequest())
      // Cancelled means the customer moved on while it was in the air (no
      // thanks, not me, the till locking). The answer is no longer theirs.
      ensureActive()
      result.fold(
        onSuccess = { signIn(it, epoch) },
        onFailure = { show(RewardsPanel.Unavailable(it.forCustomer())) },
      )
    }
  }

  override fun fixContact() {
    val contact = joining?.first
    joining = null
    show(if (contact is RewardsContact.Email) RewardsPanel.EnterEmail() else RewardsPanel.EnterPhone())
  }

  /**
   * The birthday goes to the server in the background and the customer moves
   * straight on. If the save fails they are simply asked again next visit,
   * which costs them a tap; making them wait on it, or showing them an error
   * about a birthday, would cost more than that.
   */
  override fun submitBirthday(month: Int, day: Int) {
    val current = asking ?: return
    if (!RewardsInput.isBirthday(month, day)) return
    viewModelScope.launch { gateway.saveBirthday(current.member.customer.id, month, day) }
    ask(current.copy(birthday = false))
  }

  override fun skipBirthday() {
    val current = asking ?: return
    ask(current.copy(birthday = false))
  }

  /** A no is sent too. It is an answer, and it is what stops the question coming back. */
  override fun answerOffers(granted: Boolean, wording: String) {
    val current = asking ?: return
    val channel = current.offers ?: return
    viewModelScope.launch {
      gateway.saveOffers(current.member.customer.id, channel.wire, granted, wording)
    }
    ask(current.copy(offers = null))
  }

  override fun notMe() {
    request?.cancel()
    asking = null
    joining = null
    if (attachedId != null) {
      attachedId = null
      link?.detach()
    }
    show(RewardsPanel.EnterPhone())
  }

  override fun decline() {
    request?.cancel()
    joining = null
    show(RewardsPanel.Declined)
  }

  override fun reopen() {
    joining = null
    show(RewardsPanel.EnterPhone())
  }

  // ---------------------------------------------------------------------------

  private fun lookUp(contact: RewardsContact) {
    val epoch = saleEpoch
    show(RewardsPanel.Working)
    request?.cancel()
    request = viewModelScope.launch {
      val result = gateway.identify(contact.asRequest())
      ensureActive()
      result.fold(
        onSuccess = { member ->
          if (member == null) {
            joining = contact to epoch
            show(RewardsPanel.ConfirmJoin(contact))
          } else {
            signIn(member, epoch)
          }
        },
        onFailure = { show(RewardsPanel.Unavailable(it.forCustomer())) },
      )
    }
  }

  /**
   * [epoch] is the sale the customer was typing during. If that sale has
   * since completed, the cart on the register is somebody else's, and this
   * customer is not put on it. They are still a member and are still asked
   * their questions.
   */
  private fun signIn(dto: RewardsMemberDto, epoch: Int) {
    joining = null
    val member = dto.asMember()
    if (selling && epoch == saleEpoch) {
      attachedId = member.customer.id
      link?.attach(member.customer)
    }
    ask(
      Asking(
        member = member,
        birthday = dto.needs_birthday,
        offers = OffersChannel.entries.firstOrNull { it.wire == dto.ask_offers },
      ),
    )
  }

  /** The next question still to ask, or where the customer stands once there are none. */
  private fun ask(remaining: Asking) {
    when {
      remaining.birthday -> {
        asking = remaining
        show(RewardsPanel.AskBirthday(remaining.member))
      }
      remaining.offers != null -> {
        asking = remaining
        show(RewardsPanel.AskOffers(remaining.member, remaining.offers))
      }
      else -> settle(remaining.member)
    }
  }

  private fun settle(member: RewardsMember) {
    asking = null
    show(if (attachedId == member.customer.id) RewardsPanel.SignedIn(member) else RewardsPanel.EnterPhone())
  }

  private fun home(attached: CustomerDto?): RewardsPanel =
    if (attached != null) RewardsPanel.SignedIn(attached.asAttachedByCashier()) else RewardsPanel.EnterPhone()

  private fun show(panel: RewardsPanel) {
    _panel.value = panel
    restartIdle()
  }

  private fun restartIdle() {
    idle?.cancel()
    val wait = when (val current = _panel.value) {
      is RewardsPanel.EnterEmail, is RewardsPanel.ConfirmJoin, is RewardsPanel.Unavailable -> ENTRY_IDLE_MS
      // A no thanks stands for the sale in front of them. With no sale it is
      // a no from somebody who may already have left.
      RewardsPanel.Declined -> if (cartEmpty) ENTRY_IDLE_MS else null
      is RewardsPanel.AskBirthday, is RewardsPanel.AskOffers -> ENTRY_IDLE_MS
      is RewardsPanel.SignedIn -> if (cartEmpty && current.member.self) MEMBER_IDLE_MS else null
      else -> null
    } ?: return
    idle = viewModelScope.launch {
      delay(wait)
      onIdle()
    }
  }

  private fun onIdle() {
    when (_panel.value) {
      is RewardsPanel.EnterEmail, is RewardsPanel.ConfirmJoin,
      is RewardsPanel.Unavailable, RewardsPanel.Declined -> reopen()
      is RewardsPanel.AskBirthday, is RewardsPanel.AskOffers -> asking?.let { settle(it.member) }
      is RewardsPanel.SignedIn -> notMe()
      else -> Unit
    }
  }

  companion object {
    /** Long enough to find a phone in a bag, short enough that the next customer does not inherit it. */
    const val ENTRY_IDLE_MS = 45_000L

    /** A member who signed in and has had no sale started for this long has probably left. */
    const val MEMBER_IDLE_MS = 180_000L
  }
}

private fun RewardsContact.asRequest(): RewardsContactRequest = when (this) {
  is RewardsContact.Phone -> RewardsContactRequest(phone = e164)
  is RewardsContact.Email -> RewardsContactRequest(email = address)
}

private fun RewardsMemberDto.asMember(): RewardsMember = RewardsMember(
  customer = customer,
  firstName = customer.first_name?.trim()?.takeIf { it.isNotEmpty() },
  points = loyalty.points,
  worth = loyalty.value_minor.toLongOrNull()?.takeIf { it > 0 }?.let(::Money),
  programActive = loyalty.program_active,
  joined = joined,
  self = true,
)

/** A customer the cashier put on the sale: a name to greet, and nothing claimed about a balance. */
private fun CustomerDto.asAttachedByCashier(): RewardsMember = RewardsMember(
  customer = this,
  firstName = first_name?.trim()?.takeIf { it.isNotEmpty() },
  points = null,
  worth = null,
  programActive = false,
  joined = false,
  self = false,
)

/**
 * What to tell the customer. The server's own sentence when it sent one,
 * otherwise the same thing whether the network or the server is at fault:
 * the difference means nothing to someone holding a basket.
 */
private fun Throwable.forCustomer(): String =
  (this as? RewardsFailure)?.userMessage
    ?: "Rewards are not available right now. You can still check out."
