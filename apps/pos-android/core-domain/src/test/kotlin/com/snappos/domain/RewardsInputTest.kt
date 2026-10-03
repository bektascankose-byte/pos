package com.snappos.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RewardsInputTest {

  @Test
  fun `ten digits become the number the customer table holds`() {
    assertEquals("+12545550137", RewardsInput.phoneToE164("2545550137"))
  }

  @Test
  fun `a number that cannot exist is refused before it is sent`() {
    // Too short, too long, not digits.
    assertNull(RewardsInput.phoneToE164("254555013"))
    assertNull(RewardsInput.phoneToE164("25455501370"))
    assertNull(RewardsInput.phoneToE164("254555013a"))
    // An area code or an exchange never starts with 0 or 1.
    assertNull(RewardsInput.phoneToE164("1545550137"))
    assertNull(RewardsInput.phoneToE164("0545550137"))
    assertNull(RewardsInput.phoneToE164("2541550137"))
  }

  @Test
  fun `a stored number reads back the way a person writes it`() {
    assertEquals("(254) 555-0137", RewardsInput.formatPhone("+12545550137"))
    assertEquals("+442071234567", RewardsInput.formatPhone("+442071234567"))
  }

  @Test
  fun `what is shaped like an email is let through`() {
    assertTrue(RewardsInput.isEmail("maria@example.com"))
    assertTrue(RewardsInput.isEmail("m.lopez_77@mail.example.co"))
  }

  @Test
  fun `what cannot be an email is not`() {
    assertFalse(RewardsInput.isEmail("maria"))
    assertFalse(RewardsInput.isEmail("maria@"))
    assertFalse(RewardsInput.isEmail("@example.com"))
    assertFalse(RewardsInput.isEmail("maria@example"))
    assertFalse(RewardsInput.isEmail("maria@@example.com"))
    assertFalse(RewardsInput.isEmail("maria@example.c"))
    assertFalse(RewardsInput.isEmail("maria @example.com"))
    assertFalse(RewardsInput.isEmail("maria@.example.com"))
    assertFalse(RewardsInput.isEmail("maria@example..com"))
  }

  @Test
  fun `a leap day is a birthday, because a birthday has no year`() {
    assertEquals(29, RewardsInput.daysInMonth(2))
    assertTrue(RewardsInput.isBirthday(2, 29))
    assertFalse(RewardsInput.isBirthday(2, 30))
  }

  @Test
  fun `thirty day months stop at thirty`() {
    for (month in listOf(4, 6, 9, 11)) {
      assertTrue(RewardsInput.isBirthday(month, 30))
      assertFalse(RewardsInput.isBirthday(month, 31))
    }
    for (month in listOf(1, 3, 5, 7, 8, 10, 12)) assertTrue(RewardsInput.isBirthday(month, 31))
  }

  @Test
  fun `months and days that do not exist are refused`() {
    assertEquals(0, RewardsInput.daysInMonth(0))
    assertEquals(0, RewardsInput.daysInMonth(13))
    assertFalse(RewardsInput.isBirthday(13, 1))
    assertFalse(RewardsInput.isBirthday(5, 0))
  }
}
