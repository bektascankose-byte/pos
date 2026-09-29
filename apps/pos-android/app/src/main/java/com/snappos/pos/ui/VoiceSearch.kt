package com.snappos.pos.ui

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognitionService
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.LifecycleResumeEffect

/**
 * How long the cashier can pause before what they said is taken as finished.
 *
 * The shop asked for "a second or two". A second and a half is long enough to
 * breathe between "Foger" and "Blue Razz" without the search firing on half a
 * name, and short enough that nobody stands there wondering whether it heard.
 */
private const val SETTLE_MS = 1500L

/**
 * Voice search, on whatever speech recogniser the till has.
 *
 * Built on Android's own `SpeechRecognizer` rather than on one vendor's
 * library, so it uses whichever recognition service is installed -- on this
 * shop's till that means the Google app, installed from the Play Store, and
 * until it is installed there is nothing to talk to. [available] says which,
 * and the scan field only shows a microphone when there is one to use: a
 * button that can only ever fail is worse than no button.
 *
 * What the cashier says appears in the field as they say it, and the grid
 * searches along with them. The search commits on whichever comes first: the
 * recogniser deciding they have finished, or [SETTLE_MS] passing without a new
 * word. Recognisers are allowed to ignore the silence length they are asked
 * for, and some do, so the settle timer here is what actually keeps the
 * promise of "a second or two after they stop".
 *
 * The recogniser hands back several guesses, best first, and all of them go to
 * the register, which takes the first that matches a product. A recogniser
 * that has never heard of Foger may put "fogger" first and "Foger" third, and
 * the third is the one worth having.
 */
class VoiceSearch(private val context: Context) {

  /** Whether a speech recogniser is installed. Re-checked whenever the app comes back to the front. */
  var available by mutableStateOf(false)
    private set

  var listening by mutableStateOf(false)
    private set

  /** How loud the microphone is hearing, 0 to 1, so the button can show it is listening. */
  var level by mutableFloatStateOf(0f)
    private set

  private val main = Handler(Looper.getMainLooper())
  private var recognizer: SpeechRecognizer? = null
  private var lastPartial = ""
  private var cancelled = false

  /**
   * The loudest the microphone heard during one listen, in the recogniser's
   * dB. Logged when listening ends, because "it didn't hear me" has two very
   * different causes -- a microphone that delivers silence, and speech it could
   * not make out -- and this number is what tells them apart.
   */
  private var loudest = Float.NEGATIVE_INFINITY

  /** The quietest, which is the room's noise floor. A floor at the top of the scale is a microphone clipping, not a loud room. */
  private var quietest = Float.POSITIVE_INFINITY
  private var onPartial: (String) -> Unit = {}
  private var onHeard: (List<String>) -> Unit = {}
  private var onProblem: (String) -> Unit = {}

  /** Stops listening and hands over what has been heard so far, which ends in `onResults`. */
  private val settle = Runnable { recognizer?.stopListening() }

  fun refresh() {
    available = SpeechRecognizer.isRecognitionAvailable(context)
  }

  /** Start listening. Must be called with the microphone permission already granted. */
  fun start(
    onPartial: (String) -> Unit,
    onHeard: (List<String>) -> Unit,
    onProblem: (String) -> Unit,
  ) {
    if (listening) return
    if (!SpeechRecognizer.isRecognitionAvailable(context)) {
      available = false
      onProblem("Voice search needs a speech app on this till. Install the Google app from the Play Store.")
      return
    }
    this.onPartial = onPartial
    this.onHeard = onHeard
    this.onProblem = onProblem
    lastPartial = ""
    cancelled = false
    loudest = Float.NEGATIVE_INFINITY
    quietest = Float.POSITIVE_INFINITY
    level = 0f

    val recognizer = recognizer ?: createRecognizer().also {
      it.setRecognitionListener(listener)
      recognizer = it
    }
    listening = true
    recognizer.startListening(
      Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 5)
        putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
        // As Ints. Google's recogniser reads these with getInt, and a Long is
        // silently read as 0 -- which on this till it logged and ignored.
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, SETTLE_MS.toInt())
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, SETTLE_MS.toInt())
      },
    )
  }

  /** Stop without searching: the cashier tapped the microphone again, started typing, or scanned. */
  fun cancel() {
    if (!listening) return
    cancelled = true
    finish()
    recognizer?.cancel()
  }

  fun release() {
    cancel()
    recognizer?.destroy()
    recognizer = null
  }

  /**
   * The phone's chosen speech service if it has one, otherwise the first
   * installed.
   *
   * Android only uses the service named in its voice input setting, and on a
   * till that has never had one that setting is empty -- installing the Google
   * app does not always fill it in. Asking for "the default" would then fail
   * with a bare client error while a perfectly good recogniser sits installed.
   * Naming the service directly needs no setting changed on the till.
   */
  private fun createRecognizer(): SpeechRecognizer {
    val chosen = Settings.Secure.getString(context.contentResolver, VOICE_RECOGNITION_SERVICE)
      ?.let(ComponentName::unflattenFromString)
    if (chosen != null) return SpeechRecognizer.createSpeechRecognizer(context)
    val installed = context.packageManager
      .queryIntentServices(Intent(RecognitionService.SERVICE_INTERFACE), 0)
      .firstOrNull()?.serviceInfo
      ?.let { ComponentName(it.packageName, it.name) }
    return SpeechRecognizer.createSpeechRecognizer(context, installed)
  }

  private fun finish() {
    main.removeCallbacks(settle)
    listening = false
    level = 0f
  }

  private val listener = object : RecognitionListener {
    override fun onReadyForSpeech(params: Bundle?) = Unit
    override fun onBeginningOfSpeech() = Unit
    override fun onBufferReceived(buffer: ByteArray?) = Unit
    override fun onEndOfSpeech() = Unit
    override fun onEvent(eventType: Int, params: Bundle?) = Unit

    override fun onRmsChanged(rmsdB: Float) {
      if (rmsdB > loudest) loudest = rmsdB
      if (rmsdB < quietest) quietest = rmsdB
      // Roughly -2 dB in a quiet shop to 10 dB for a voice at arm's length.
      level = ((rmsdB + 2f) / 12f).coerceIn(0f, 1f)
    }

    override fun onPartialResults(partialResults: Bundle?) {
      if (cancelled) return
      val heard = partialResults.guesses().firstOrNull().orEmpty()
      if (heard.isBlank() || heard == lastPartial) return
      lastPartial = heard
      onPartial(heard)
      // Every new word pushes the finish line back.
      main.removeCallbacks(settle)
      main.postDelayed(settle, SETTLE_MS)
    }

    override fun onResults(results: Bundle?) {
      if (cancelled) return
      finish()
      val guesses = results.guesses().ifEmpty { listOf(lastPartial) }.filter { it.isNotBlank() }
      Log.i(TAG, "heard ${guesses.size} guesses, level $quietest..$loudest dB")
      if (guesses.isEmpty()) onProblem(NOTHING_HEARD) else onHeard(guesses)
    }

    override fun onError(error: Int) {
      if (cancelled) return
      finish()
      Log.i(TAG, "ended with error $error, level $quietest..$loudest dB, partial \"$lastPartial\"")
      // Stopping on our own timer can end in "no match" even though words were
      // heard and shown. What was shown is what the cashier expects searched.
      if (lastPartial.isNotBlank() && error == SpeechRecognizer.ERROR_NO_MATCH) {
        onHeard(listOf(lastPartial))
        return
      }
      onProblem(
        when (error) {
          SpeechRecognizer.ERROR_NO_MATCH,
          SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> NOTHING_HEARD
          SpeechRecognizer.ERROR_NETWORK,
          SpeechRecognizer.ERROR_NETWORK_TIMEOUT,
          SpeechRecognizer.ERROR_SERVER -> "Voice search needs the internet, and the till isn't reaching it."
          SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "SnapPOS isn't allowed to use the microphone."
          SpeechRecognizer.ERROR_AUDIO -> "The till's microphone isn't working."
          SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Voice search is busy. Try again in a moment."
          else -> "Voice search stopped (error $error)."
        },
      )
    }
  }

  private fun Bundle?.guesses(): List<String> =
    this?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).orEmpty()

  private companion object {
    const val NOTHING_HEARD = "Didn't hear a product. Tap the microphone and try again."
    const val TAG = "VoiceSearch"

    /** `Settings.Secure.VOICE_RECOGNITION_SERVICE`, which the SDK hides. Readable, never written. */
    const val VOICE_RECOGNITION_SERVICE = "voice_recognition_service"
  }
}

/**
 * One [VoiceSearch] for as long as the scan field is on screen.
 *
 * Availability is re-checked each time the app comes back to the front, which
 * is exactly when it can change: someone went to the Play Store, installed the
 * Google app and came back. Listening stops when the app leaves the front,
 * because a microphone left open behind another app is not something a till
 * should ever do.
 */
@Composable
fun rememberVoiceSearch(): VoiceSearch {
  val context = LocalContext.current
  val voice = remember { VoiceSearch(context.applicationContext) }
  LifecycleResumeEffect(voice) {
    voice.refresh()
    onPauseOrDispose { voice.cancel() }
  }
  DisposableEffect(voice) { onDispose { voice.release() } }
  return voice
}
