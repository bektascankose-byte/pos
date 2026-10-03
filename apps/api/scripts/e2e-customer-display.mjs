/**
 * The customer's own screen: rewards sign in at the counter.
 *
 * Everything here is done with the cashier's token, because that is who the
 * register is signed in as and the point of these routes is that a plain
 * cashier's shift can still take a new member. The owner's token is only used
 * to look at what was written.
 *
 * Imported by e2e.mjs, sharing its server and its reset. Uses phone numbers
 * and emails of its own so nothing the other checks count is touched.
 */

export async function runCustomerDisplayChecks({ api, check, ownerToken, cashierToken }) {
  const post = (path, body, token = cashierToken) =>
    api(`/api/v1/customer-display/${path}`, { token, method: 'POST', body });

  const phone = '+12545550137';

  // ------------------------------------------------------------- the lookup

  const stranger = await post('identify', { phone });
  check(
    'a number nobody has given before is not a member',
    stranger.status === 200 && stranger.body?.found === false && stranger.body?.member === null,
    JSON.stringify(stranger.body),
  );

  const bare = await post('identify', { phone: '2545550137' });
  check('ten bare digits are refused rather than guessed at', bare.status === 400, JSON.stringify(bare.body));

  const both = await post('identify', { phone, email: 'someone@example.com' });
  check('a phone and an email together are refused', both.status === 400, JSON.stringify(both.body));

  const neither = await post('identify', {});
  check('a lookup with no contact is refused', neither.status === 400, JSON.stringify(neither.body));

  const anonymous = await api('/api/v1/customer-display/identify', { method: 'POST', body: { phone } });
  check('the lookup needs a signed in register', anonymous.status === 401, JSON.stringify(anonymous.body));

  // ---------------------------------------------------------------- joining

  const counter = await api('/api/v1/customers', { token: cashierToken, method: 'POST', body: { phone } });
  check(
    'a cashier still cannot create a customer the back office way',
    counter.status === 403,
    JSON.stringify(counter.body),
  );

  const joined = await post('join', { phone });
  const memberId = joined.body?.customer?.id;
  check(
    'the customer joins on their own screen during that same cashier shift',
    joined.status === 200 && joined.body?.joined === true && typeof memberId === 'string' &&
      joined.body?.customer?.phone === phone && joined.body?.customer?.first_name === null,
    JSON.stringify(joined.body),
  );
  check(
    'a new member is asked for a birthday and about texts, and starts with no points',
    joined.body?.needs_birthday === true && joined.body?.ask_offers === 'sms' &&
      joined.body?.loyalty?.points === 0,
    JSON.stringify(joined.body),
  );

  const twice = await post('join', { phone });
  check(
    'tapping Join twice finds the same member instead of making a second',
    twice.status === 200 && twice.body?.joined === false && twice.body?.customer?.id === memberId,
    JSON.stringify(twice.body),
  );

  const back = await post('identify', { phone });
  check(
    'the number now finds them',
    back.body?.found === true && back.body?.member?.customer?.id === memberId &&
      back.body?.member?.joined === false,
    JSON.stringify(back.body),
  );

  // --------------------------------------------------------------- birthday

  const april31 = await post(`customers/${memberId}/birthday`, { birth_month: 4, birth_day: 31 });
  check('April 31 is not a birthday', april31.status === 400, JSON.stringify(april31.body));

  const leap = await post(`customers/${memberId}/birthday`, { birth_month: 2, birth_day: 29 });
  check('a leap day is', leap.status === 200 && leap.body?.saved === true, JSON.stringify(leap.body));

  const moved = await post(`customers/${memberId}/birthday`, { birth_month: 5, birth_day: 5 });
  const onFile = await api(`/api/v1/customers/${memberId}`, { token: ownerToken });
  check(
    'a second birthday changes nothing: the screen cannot move one already given',
    moved.status === 200 && moved.body?.saved === false &&
      onFile.body?.birth_month === 2 && onFile.body?.birth_day === 29,
    JSON.stringify({ moved: moved.body, month: onFile.body?.birth_month, day: onFile.body?.birth_day }),
  );

  const afterBirthday = await post('identify', { phone });
  check(
    'and they are not asked for it again',
    afterBirthday.body?.member?.needs_birthday === false,
    JSON.stringify(afterBirthday.body?.member),
  );

  // ----------------------------------------------------------------- offers

  const wording = 'Want deals by text? We only send real deals. No spam and we never share your information.';

  const wrongChannel = await post(`customers/${memberId}/offers`, { channel: 'email', granted: true, wording });
  check(
    'consent to email someone with no email on file is refused',
    wrongChannel.status === 400,
    JSON.stringify(wrongChannel.body),
  );

  const unworded = await post(`customers/${memberId}/offers`, { channel: 'sms', granted: true });
  check('an answer with no record of the question is refused', unworded.status === 400, JSON.stringify(unworded.body));

  const yes = await post(`customers/${memberId}/offers`, { channel: 'sms', granted: true, wording });
  const consents = await api(`/api/v1/customers/${memberId}/consents`, { token: ownerToken });
  const sms = consents.body?.find?.((c) => c.channel === 'sms');
  const emailState = consents.body?.find?.((c) => c.channel === 'email');
  check(
    'a yes to texts lands in the consent log as given at the register',
    yes.status === 200 && yes.body?.saved === true && sms?.granted === true && sms?.source === 'register' &&
      emailState?.never_asked === true,
    JSON.stringify(consents.body),
  );

  const history = await api(`/api/v1/customers/${memberId}/consents/history`, { token: ownerToken });
  const event = history.body?.[0];
  check(
    'with the words the customer was shown and the screen it came from',
    event?.evidence?.wording === wording && event?.evidence?.via === 'customer_display',
    JSON.stringify(event),
  );

  const afterYes = await post('identify', { phone });
  check(
    'once answered, the question is not asked again',
    afterYes.body?.member?.ask_offers === null,
    JSON.stringify(afterYes.body?.member),
  );

  // ------------------------------------------------------------ by email

  const byEmail = await post('join', { email: 'E2E.Tap@Example.com' });
  const emailMemberId = byEmail.body?.customer?.id;
  check(
    'a customer who would rather not give a phone joins with an email',
    byEmail.status === 200 && byEmail.body?.joined === true &&
      byEmail.body?.customer?.email === 'e2e.tap@example.com' && byEmail.body?.customer?.phone === null &&
      byEmail.body?.ask_offers === 'email',
    JSON.stringify(byEmail.body),
  );

  const shouted = await post('identify', { email: 'e2e.TAP@example.COM' });
  check(
    'and is found again however they capitalise it',
    shouted.body?.found === true && shouted.body?.member?.customer?.id === emailMemberId,
    JSON.stringify(shouted.body),
  );

  const fragment = await post('identify', { email: 'e2e.tap' });
  check('part of an email finds nobody: it is not an email', fragment.status === 400, JSON.stringify(fragment.body));

  const no = await post(`customers/${emailMemberId}/offers`, {
    channel: 'email',
    granted: false,
    wording: 'Want deals by email?',
  });
  const emailConsents = await api(`/api/v1/customers/${emailMemberId}/consents`, { token: ownerToken });
  const declined = emailConsents.body?.find?.((c) => c.channel === 'email');
  const afterNo = await post('identify', { email: 'e2e.tap@example.com' });
  check(
    'a no is recorded as an answer, and is not asked again either',
    no.status === 200 && declined?.granted === false && declined?.never_asked === false &&
      afterNo.body?.member?.ask_offers === null,
    JSON.stringify({ declined, ask: afterNo.body?.member?.ask_offers }),
  );

  // ------------------------------------------------- a customer the shop removed

  const archived = await api(`/api/v1/customers/${emailMemberId}`, {
    token: ownerToken,
    method: 'PATCH',
    body: { status: 'archived' },
  });
  const gone = await post('identify', { email: 'e2e.tap@example.com' });
  const rejoin = await post('join', { email: 'e2e.tap@example.com' });
  check(
    'an archived customer is not found, and cannot bring themselves back from the keypad',
    archived.status === 200 && gone.body?.found === false && rejoin.status === 409,
    JSON.stringify({ archived: archived.status, gone: gone.body, rejoin: rejoin.status }),
  );

  const ghost = await post(`customers/${emailMemberId}/birthday`, { birth_month: 1, birth_day: 1 });
  check('nor be given a birthday', ghost.status === 404, JSON.stringify(ghost.body));
}
