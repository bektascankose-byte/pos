package com.snappos.data.crypto

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlin.random.Random

/**
 * The SQLCipher passphrase.
 *
 * The database holds the catalog, employee PIN hashes and every sale taken
 * since the last sync. A register is a device that sits on a counter all day
 * and occasionally leaves in someone's pocket, so the file is encrypted and the
 * key is never in the APK.
 *
 * How it works: a random 32 byte passphrase is generated once, then sealed with
 * an AES key that lives in the **Android Keystore** and is marked
 * non-exportable. The sealed blob sits in SharedPreferences, which is fine
 * precisely because it is useless without the Keystore key — and that key is
 * held by hardware on any device with a TEE or StrongBox, which is every phone
 * and every modern terminal.
 *
 * Two things this deliberately does not do:
 *
 *   - **No user authentication requirement on the key.** It is tempting to
 *     require a device unlock, but the register must open its database on boot
 *     so a shift can start without someone knowing the terminal's screen lock.
 *     The PIN gate belongs in the app, in front of the till, not in front of
 *     the file.
 *
 *   - **No key rotation on reinstall.** The passphrase survives as long as the
 *     Keystore entry does. If the Keystore entry is ever lost, the database is
 *     unreadable and the correct behaviour is to fail loudly and re-sync from
 *     the server, not to silently create a new empty database over the top of
 *     unuploaded sales.
 */
object DatabaseKey {

  private const val KEYSTORE = "AndroidKeyStore"
  private const val KEY_ALIAS = "snappos_db_key"
  private const val PREFS = "snappos_secure"
  private const val PREF_SEALED = "db_passphrase_sealed"
  private const val PREF_IV = "db_passphrase_iv"
  private const val GCM_TAG_BITS = 128
  private const val PASSPHRASE_BYTES = 32

  class UnavailableException(message: String, cause: Throwable? = null) :
    IllegalStateException(message, cause)

  /** The passphrase for this device, generating and sealing one on first run. */
  fun get(context: Context): ByteArray {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val sealed = prefs.getString(PREF_SEALED, null)
    val iv = prefs.getString(PREF_IV, null)

    if (sealed != null && iv != null) {
      return try {
        unseal(android.util.Base64.decode(sealed, android.util.Base64.NO_WRAP),
               android.util.Base64.decode(iv, android.util.Base64.NO_WRAP))
      } catch (e: Exception) {
        // The Keystore entry is gone or the blob is corrupt. Creating a fresh
        // passphrase here would leave the existing encrypted file unreadable
        // and Room would want to recreate it, destroying any sale that had not
        // uploaded. Fail instead, and let the app recover deliberately.
        throw UnavailableException(
          "the database key could not be unsealed; the local database cannot be opened",
          e,
        )
      }
    }

    val passphrase = Random.Default.nextBytes(PASSPHRASE_BYTES)
    val (blob, nonce) = seal(passphrase)
    prefs.edit()
      .putString(PREF_SEALED, android.util.Base64.encodeToString(blob, android.util.Base64.NO_WRAP))
      .putString(PREF_IV, android.util.Base64.encodeToString(nonce, android.util.Base64.NO_WRAP))
      .commit()
    return passphrase
  }

  /**
   * Whether a passphrase already exists.
   *
   * Used at startup to tell "this device has never been claimed" apart from
   * "this device was claimed and its key is now unreadable". They need very
   * different responses: the first is normal setup, the second is a fault.
   */
  fun exists(context: Context): Boolean =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).contains(PREF_SEALED)

  private fun seal(plaintext: ByteArray): Pair<ByteArray, ByteArray> {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, keystoreKey())
    return cipher.doFinal(plaintext) to cipher.iv
  }

  private fun unseal(blob: ByteArray, iv: ByteArray): ByteArray {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, keystoreKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
    return cipher.doFinal(blob)
  }

  private fun keystoreKey(): SecretKey {
    val keystore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    (keystore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }

    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
    generator.init(
      KeyGenParameterSpec.Builder(
        KEY_ALIAS,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
      )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        // Deliberately not setUserAuthenticationRequired: the register must be
        // able to open its database on boot so a shift can start without
        // someone knowing the terminal's screen lock. The PIN gate is in the
        // app, in front of the till.
        .build(),
    )
    return generator.generateKey()
  }
}
