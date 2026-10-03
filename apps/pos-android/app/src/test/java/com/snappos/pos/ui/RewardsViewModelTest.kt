package com.snappos.pos.ui

import com.snappos.sync.CustomerDto
import com.snappos.sync.RewardsBalanceDto
import com.snappos.sync.RewardsContactRequest
import com.snappos.sync.RewardsFailure
import com.snappos.sync.RewardsGateway
import com.snappos.sync.RewardsMemberDto
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The customer's side of a sale, without a screen or a server.
 *
 * What is being pinned down is the conversation: which question comes next,
 * what the register is told, and what happens when the sale finishes or the
 * customer walks off in the middle of it.
 *
 * Time is virtual. `settle()` runs what is ready now and never moves the
 * clock, because moving it would also fire the walk away timers, which are
 * their own tests.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class RewardsViewModelTest {

  private val dispatcher = StandardTestDispatcher()

  private val maria = CustomerDto(id = "c-maria", first_name = " Maria ", phone = "+12545550137")
  private val newcomer = CustomerDto(id = "c-new", phone = "+12545550199")

  private class FakeGateway : RewardsGateway {
    val members = mutableMapOf<String, RewardsMemberDto>()
    var joinAs: RewardsMemberDto? = null
    var failWith: RewardsFailure? = null

    /** When set, lookups and joins wait on it, so a test can act while one is in the air. */
    var gate: CompletableDeferred<Unit>? = null
    val birthdays = mutableListOf<Triple<String, Int, Int>>()
    val offers = mutableListOf<List<Any>>()
    val lookups = mutableListOf<RewardsContactRequest>()

    override suspend fun identify(contact: RewardsContactRequest): Result<RewardsMemberDto?> {
      lookups += contact
      gate?.await()
      failWith?.let { return Result.failure(it) }
      return Result.success(members[contact.phone ?: contact.email])
    }

    override suspend fun join(contact: RewardsContactRequest): Result<RewardsMemberDto> {
      gate?.await()
      failWith?.let { return Result.failure(it) }
      return Result.success(joinAs!!)
    }

    override suspend fun saveBirthday(customerId: String, month: Int, day: Int): Result<Boolean> {
      birthdays += Triple(customerId, month, day)
      return Result.success(true)
    }

    override suspend fun saveOffers(
      customerId: String,
      channel: String,
      granted: Boolean,
      wording: String,
    ): Result<Boolean> {
      offers += listOf(customerId, channel, granted, wording)
      return Result.success(true)
    }
  }

  private class FakeRegister : RegisterLink {
    var attached: CustomerDto? = null
    var attaches = 0
    var detaches = 0

    override fun attach(customer: CustomerDto) {
      attached = customer
      attaches++
    }

    override fun detach() {
      attached = null
      detaches++
    }
  }

  private val gateway = FakeGateway()
  private val register = FakeRegister()
  private lateinit var rewards: RewardsViewModel

  @Before
  fun setUp() {
    Dispatchers.setMain(dispatcher)
    rewards = RewardsViewModel(gateway).also { it.connect(register) }
  }

  @After
  fun tearDown() {
    Dispatchers.resetMain()
  }

  private fun member(
    customer: CustomerDto,
    birthday: Boolean = false,
    offers: String? = null,
    joined: Boolean = false,
  ) = RewardsMemberDto(
    customer = customer,
    joined = joined,
    needs_birthday = birthday,
    ask_offers = offers,
    loyalty = RewardsBalanceDto("Rewards", true, 128, "128"),
  )

  /** Tell the screen about the register, the way the real one does: the whole picture. */
  private fun selling(cartEmpty: Boolean = true, lastReceiptNo: String? = null) {
    rewards.onRegister(selling = true, attached = register.attached, cartEmpty = cartEmpty, lastReceiptNo = lastReceiptNo)
    settle()
  }

  /** The register rings the sale up: whoever was on it comes off. */
  private fun completeSale(id: String) {
    register.attached = null
    selling(cartEmpty = true, lastReceiptNo = id)
  }

  private fun settle() = dispatcher.scheduler.runCurrent()

  private fun idleFor(ms: Long) {
    dispatcher.scheduler.advanceTimeBy(ms)
    dispatcher.scheduler.runCurrent()
  }

  private fun typePhone(digits: String) {
    rewards.submitPhone(digits)
    settle()
  }

  private val panel get() = rewards.panel.value

  // ------------------------------------------------------------ the keypad

  @Test
  fun `a till that cannot ring a sale offers nothing to tap`() {
    assertEquals(RewardsPanel.Resting, panel)
    rewards.onRegister(selling = false, attached = null, cartEmpty = true, lastReceiptNo = null)
    assertEquals(RewardsPanel.Resting, panel)
  }

  @Test
  fun `the keypad is waiting as soon as a sale can be rung`() {
    selling()
    assertEquals(RewardsPanel.EnterPhone(), panel)
  }

  @Test
  fun `a number that cannot exist is refused without asking the server`() {
    selling()
    typePhone("1545550137")
    assertEquals(RewardsPanel.EnterPhone(problem = "Check the number and try again."), panel)
    assertTrue(gateway.lookups.isEmpty())
  }

  // ------------------------------------------------------------- signing in

  @Test
  fun `a known number signs the member in and puts them on the sale`() {
    gateway.members["+12545550137"] = member(maria)
    selling()
    typePhone("2545550137")

    val shown = panel as RewardsPanel.SignedIn
    assertEquals("Maria", shown.member.firstName)
    assertEquals(128, shown.member.points)
    assertEquals(128L, shown.member.worth?.minor)
    assertEquals(maria, register.attached)
    assertEquals(RewardsContactRequest(phone = "+12545550137"), gateway.lookups.single())
  }

  @Test
  fun `a new number is offered a join and nothing is attached until they take it`() {
    gateway.joinAs = member(newcomer, birthday = true, offers = "sms", joined = true)
    selling()
    typePhone("2545550199")

    assertEquals(RewardsPanel.ConfirmJoin(RewardsContact.Phone("+12545550199")), panel)
    assertEquals("(254) 555-0199", (panel as RewardsPanel.ConfirmJoin).contact.shown)
    assertEquals(0, register.attaches)

    rewards.confirmJoin()
    settle()
    assertTrue(panel is RewardsPanel.AskBirthday)
    assertEquals(newcomer, register.attached)
  }

  @Test
  fun `fixing a mistyped contact returns to the keypad it was typed on`() {
    selling()
    typePhone("2545550199")
    rewards.fixContact()
    assertEquals(RewardsPanel.EnterPhone(), panel)

    rewards.useEmail()
    rewards.submitEmail("new@example.com")
    settle()
    assertTrue(panel is RewardsPanel.ConfirmJoin)
    rewards.fixContact()
    assertEquals(RewardsPanel.EnterEmail(), panel)
  }

  @Test
  fun `an email is tidied and looked up as an email`() {
    gateway.members["maria@example.com"] = member(maria)
    selling()
    rewards.useEmail()
    assertEquals(RewardsPanel.EnterEmail(), panel)

    rewards.submitEmail("  Maria@Example.com ")
    settle()
    assertEquals(RewardsContactRequest(email = "maria@example.com"), gateway.lookups.single())
    assertTrue(panel is RewardsPanel.SignedIn)
  }

  @Test
  fun `what is not an email is refused without asking the server`() {
    selling()
    rewards.useEmail()
    rewards.submitEmail("maria@example")
    settle()
    assertEquals(RewardsPanel.EnterEmail(problem = "Check the email and try again."), panel)
    assertTrue(gateway.lookups.isEmpty())
  }

  // ---------------------------------------------------------- the questions

  @Test
  fun `the questions come in order - birthday, then offers, then the welcome`() {
    gateway.members["+12545550137"] = member(maria, birthday = true, offers = "sms")
    selling()
    typePhone("2545550137")
    assertTrue(panel is RewardsPanel.AskBirthday)

    rewards.submitBirthday(2, 29)
    settle()
    assertEquals(listOf(Triple("c-maria", 2, 29)), gateway.birthdays)
    assertEquals(OffersChannel.Sms, (panel as RewardsPanel.AskOffers).channel)

    rewards.answerOffers(granted = true, wording = "Want deals by text?")
    settle()
    assertEquals(listOf(listOf("c-maria", "sms", true, "Want deals by text?")), gateway.offers)
    assertTrue(panel is RewardsPanel.SignedIn)
  }

  @Test
  fun `skipping the birthday saves nothing and moves on`() {
    gateway.members["+12545550137"] = member(maria, birthday = true)
    selling()
    typePhone("2545550137")
    rewards.skipBirthday()
    settle()
    assertTrue(gateway.birthdays.isEmpty())
    assertTrue(panel is RewardsPanel.SignedIn)
  }

  @Test
  fun `a day the month does not have is not sent`() {
    gateway.members["+12545550137"] = member(maria, birthday = true)
    selling()
    typePhone("2545550137")
    rewards.submitBirthday(4, 31)
    settle()
    assertTrue(gateway.birthdays.isEmpty())
    assertTrue(panel is RewardsPanel.AskBirthday)
  }

  @Test
  fun `a no to offers is an answer and is sent like a yes`() {
    gateway.members["maria@example.com"] = member(maria, offers = "email")
    selling()
    rewards.useEmail()
    rewards.submitEmail("maria@example.com")
    settle()
    assertEquals(OffersChannel.Email, (panel as RewardsPanel.AskOffers).channel)

    rewards.answerOffers(granted = false, wording = "Want deals by email?")
    settle()
    assertEquals(listOf(listOf("c-maria", "email", false, "Want deals by email?")), gateway.offers)
    assertTrue(panel is RewardsPanel.SignedIn)
  }

  // ------------------------------------- a sale finishing under the customer

  @Test
  fun `a sale completing mid question leaves the question up and still saves the answer`() {
    gateway.members["+12545550137"] = member(maria, birthday = true)
    selling(cartEmpty = false)
    typePhone("2545550137")
    assertEquals(maria, register.attached)

    completeSale("sale-1")
    assertTrue(panel is RewardsPanel.AskBirthday)

    rewards.submitBirthday(7, 4)
    settle()
    assertEquals(listOf(Triple("c-maria", 7, 4)), gateway.birthdays)
    // Their sale is done, so there is nobody to welcome onto the next one.
    assertEquals(RewardsPanel.EnterPhone(), panel)
    assertNull(register.attached)
  }

  @Test
  fun `a lookup that lands after the sale completed is not put on the next customer's sale`() {
    gateway.members["+12545550137"] = member(maria)
    gateway.gate = CompletableDeferred()
    selling(cartEmpty = false)
    typePhone("2545550137")
    assertEquals(RewardsPanel.Working, panel)

    completeSale("sale-1")
    gateway.gate!!.complete(Unit)
    settle()

    assertEquals(0, register.attaches)
    assertEquals(RewardsPanel.EnterPhone(), panel)
  }

  @Test
  fun `a join confirmed after the sale completed makes the member but attaches nothing`() {
    gateway.joinAs = member(newcomer, birthday = true, joined = true)
    selling(cartEmpty = false)
    typePhone("2545550199")
    assertTrue(panel is RewardsPanel.ConfirmJoin)

    completeSale("sale-1")
    assertTrue(panel is RewardsPanel.ConfirmJoin)
    rewards.confirmJoin()
    settle()

    assertEquals(0, register.attaches)
    assertTrue(panel is RewardsPanel.AskBirthday)
  }

  @Test
  fun `after a sale the screen is ready for the next customer`() {
    gateway.members["+12545550137"] = member(maria)
    selling(cartEmpty = false)
    typePhone("2545550137")
    assertTrue(panel is RewardsPanel.SignedIn)

    completeSale("sale-1")
    assertEquals(RewardsPanel.EnterPhone(), panel)
  }

  // ------------------------------------------------- changing their mind

  @Test
  fun `no thanks while a lookup is in the air wins over its answer`() {
    gateway.members["+12545550137"] = member(maria)
    gateway.gate = CompletableDeferred()
    selling()
    typePhone("2545550137")

    rewards.decline()
    gateway.gate!!.complete(Unit)
    settle()

    assertEquals(RewardsPanel.Declined, panel)
    assertEquals(0, register.attaches)
  }

  @Test
  fun `not me takes the customer off the sale`() {
    gateway.members["+12545550137"] = member(maria)
    selling()
    typePhone("2545550137")

    rewards.notMe()
    assertEquals(1, register.detaches)
    assertNull(register.attached)
    assertEquals(RewardsPanel.EnterPhone(), panel)
  }

  @Test
  fun `no thanks stands for the sale in progress and is forgotten when it completes`() {
    selling(cartEmpty = false)
    rewards.decline()
    idleFor(RewardsViewModel.ENTRY_IDLE_MS * 4)
    assertEquals(RewardsPanel.Declined, panel)

    completeSale("sale-1")
    assertEquals(RewardsPanel.EnterPhone(), panel)
  }

  @Test
  fun `no thanks with no sale started lapses, because whoever said it may have left`() {
    selling(cartEmpty = true)
    rewards.decline()
    idleFor(RewardsViewModel.ENTRY_IDLE_MS + 1)
    assertEquals(RewardsPanel.EnterPhone(), panel)
  }

  // ------------------------------------------------------ walking away

  @Test
  fun `a member who signs in and never starts a sale is signed back out`() {
    gateway.members["+12545550137"] = member(maria)
    selling(cartEmpty = true)
    typePhone("2545550137")

    idleFor(RewardsViewModel.MEMBER_IDLE_MS - 1_000)
    assertTrue(panel is RewardsPanel.SignedIn)
    idleFor(2_000)
    assertEquals(RewardsPanel.EnterPhone(), panel)
    assertEquals(1, register.detaches)
  }

  @Test
  fun `a member with a sale in progress is never signed out by the clock`() {
    gateway.members["+12545550137"] = member(maria)
    selling(cartEmpty = true)
    typePhone("2545550137")
    selling(cartEmpty = false)

    idleFor(RewardsViewModel.MEMBER_IDLE_MS * 3)
    assertTrue(panel is RewardsPanel.SignedIn)
    assertEquals(0, register.detaches)
  }

  @Test
  fun `an abandoned join question goes back to the keypad`() {
    selling()
    typePhone("2545550199")
    assertTrue(panel is RewardsPanel.ConfirmJoin)
    idleFor(RewardsViewModel.ENTRY_IDLE_MS + 1)
    assertEquals(RewardsPanel.EnterPhone(), panel)
  }

  @Test
  fun `an abandoned question leaves the member signed in for their sale`() {
    gateway.members["+12545550137"] = member(maria, birthday = true, offers = "sms")
    selling(cartEmpty = false)
    typePhone("2545550137")
    idleFor(RewardsViewModel.ENTRY_IDLE_MS + 1)

    assertTrue(panel is RewardsPanel.SignedIn)
    assertTrue(gateway.birthdays.isEmpty())
    assertTrue(gateway.offers.isEmpty())
  }

  @Test
  fun `typing keeps an email entry alive`() {
    selling()
    rewards.useEmail()
    repeat(5) {
      idleFor(RewardsViewModel.ENTRY_IDLE_MS - 1_000)
      rewards.touch()
    }
    assertEquals(RewardsPanel.EnterEmail(), panel)
    idleFor(RewardsViewModel.ENTRY_IDLE_MS + 1)
    assertEquals(RewardsPanel.EnterPhone(), panel)
  }

  // ------------------------------------------------- the cashier's side

  @Test
  fun `a customer the cashier attached is greeted, with no balance claimed`() {
    register.attached = maria
    selling()
    val shown = panel as RewardsPanel.SignedIn
    assertEquals("Maria", shown.member.firstName)
    assertNull(shown.member.points)

    // And the clock leaves them alone: the cashier put them there on purpose.
    idleFor(RewardsViewModel.MEMBER_IDLE_MS * 2)
    assertTrue(panel is RewardsPanel.SignedIn)
    assertEquals(0, register.detaches)
  }

  @Test
  fun `the cashier taking the customer off the sale returns the keypad`() {
    gateway.members["+12545550137"] = member(maria)
    selling()
    typePhone("2545550137")

    register.attached = null
    selling()
    assertEquals(RewardsPanel.EnterPhone(), panel)
    assertEquals(0, register.detaches)
  }

  @Test
  fun `locking the till clears the conversation`() {
    gateway.members["+12545550137"] = member(maria, birthday = true)
    selling()
    typePhone("2545550137")

    rewards.onRegister(selling = false, attached = null, cartEmpty = true, lastReceiptNo = null)
    assertEquals(RewardsPanel.Resting, panel)
    rewards.submitBirthday(7, 4)
    settle()
    assertTrue(gateway.birthdays.isEmpty())
    assertEquals(RewardsPanel.Resting, panel)
  }

  // ------------------------------------------------------- when it fails

  @Test
  fun `no connection says so plainly and the keypad comes back`() {
    gateway.failWith = RewardsFailure("no connection", offline = true)
    selling()
    typePhone("2545550137")
    assertEquals(
      RewardsPanel.Unavailable("Rewards are not available right now. You can still check out."),
      panel,
    )
    assertEquals(0, register.attaches)

    idleFor(RewardsViewModel.ENTRY_IDLE_MS + 1)
    assertEquals(RewardsPanel.EnterPhone(), panel)
  }

  @Test
  fun `the server's own sentence for the customer is the one shown`() {
    selling()
    typePhone("2545550199")
    gateway.failWith = RewardsFailure("removed", userMessage = "Please ask the cashier to add you.")
    rewards.confirmJoin()
    settle()
    assertEquals(RewardsPanel.Unavailable("Please ask the cashier to add you."), panel)
  }
}
