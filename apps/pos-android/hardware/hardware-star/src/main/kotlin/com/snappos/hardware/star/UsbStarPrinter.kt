package com.snappos.hardware.star

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.snappos.domain.ReceiptDocument
import com.snappos.hardware.PrintResult
import com.snappos.hardware.PrinterProvider
import com.snappos.hardware.PrinterStatus
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

/**
 * A Star TSP100-family printer on the till's USB, with the cash drawer on its
 * drawer port.
 *
 * **It shares the printer.** Modisoft prints to the same TSP143IIIU, and a USB
 * interface can only be held by one app at a time. So nothing is held between
 * jobs: every print opens the device, claims it, sends, releases and closes,
 * and a printer that Modisoft happens to be holding at that instant comes back
 * as "busy, try again" rather than as a stolen printer halfway through
 * somebody else's receipt.
 *
 * **Android asks the cashier once.** An app may not touch a USB device until
 * the person at the screen allows it, and that allowance lasts until the
 * printer is unplugged or the till restarts. The first print after either
 * shows Android's own dialog; the job waits for the answer, then carries on.
 *
 * Every failure is a [PrintResult.Failed] with a sentence a cashier can act on,
 * never an exception: see the contract on [PrinterProvider].
 */
class UsbStarPrinter(private val context: Context) : PrinterProvider {

  private val usb: UsbManager? = context.getSystemService(UsbManager::class.java)

  /** One job at a time. Two receipts interleaved on one USB pipe print as neither. */
  private val jobs = Mutex()

  override suspend fun print(document: ReceiptDocument): PrintResult {
    val bytes = try {
      withContext(Dispatchers.Default) { StarGraphic.job(ReceiptRaster.rows(document)) }
    } catch (e: Exception) {
      return PrintResult.Failed("The receipt could not be drawn: ${e.message}", retryable = false)
    }
    return send(bytes)
  }

  override suspend fun openDrawer(): PrintResult = send(StarGraphic.OPEN_DRAWER)

  override suspend fun status(): PrinterStatus {
    val found = find() ?: return PrinterStatus(ready = false, detail = "No Star printer is plugged in")
    val allowed = usb?.hasPermission(found.device) == true
    return PrinterStatus(
      ready = true,
      canOpenDrawer = true,
      detail = if (allowed) found.device.productName else "Android will ask to allow SnapPOS on the first print",
    )
  }

  private class Found(val device: UsbDevice, val printer: UsbInterface, val out: UsbEndpoint)

  /** The first Star device with a printer-class interface and a way to send it data. */
  private fun find(): Found? {
    val manager = usb ?: return null
    for (device in manager.deviceList.values) {
      if (device.vendorId != STAR_VENDOR_ID) continue
      for (i in 0 until device.interfaceCount) {
        val face = device.getInterface(i)
        if (face.interfaceClass != UsbConstants.USB_CLASS_PRINTER) continue
        val out = (0 until face.endpointCount).map(face::getEndpoint).firstOrNull {
          it.type == UsbConstants.USB_ENDPOINT_XFER_BULK && it.direction == UsbConstants.USB_DIR_OUT
        } ?: continue
        return Found(device, face, out)
      }
    }
    return null
  }

  private suspend fun send(bytes: ByteArray): PrintResult = jobs.withLock {
    val manager = usb ?: return@withLock PrintResult.NoPrinter
    val found = find() ?: return@withLock PrintResult.NoPrinter
    if (!manager.hasPermission(found.device) && !askPermission(manager, found.device)) {
      return@withLock PrintResult.Failed("SnapPOS was not allowed to use the printer. Print again and tap OK.")
    }
    withContext(Dispatchers.IO) { transfer(manager, found, bytes) }
  }

  private fun transfer(manager: UsbManager, found: Found, bytes: ByteArray): PrintResult {
    val connection = try {
      manager.openDevice(found.device)
    } catch (e: SecurityException) {
      null
    } ?: return PrintResult.Failed("The printer could not be opened. Check its cable and power.")
    try {
      // Forced: the kernel's own printer driver sits on this interface and has
      // to be moved aside. Another app holding it is a different matter, and
      // comes back false.
      if (!connection.claimInterface(found.printer, true)) {
        return PrintResult.Failed("The printer is busy with another app. Try again in a moment.")
      }
      try {
        var offset = 0
        while (offset < bytes.size) {
          val end = minOf(offset + CHUNK, bytes.size)
          // The offset overload of bulkTransfer is API 28; the till is 30 but
          // the app supports 26, so chunks are copied instead.
          val chunk = bytes.copyOfRange(offset, end)
          val sent = connection.bulkTransfer(found.out, chunk, chunk.size, TIMEOUT_MS)
          if (sent <= 0) {
            return PrintResult.Failed("The printer stopped taking data. Check the paper and that the cover is shut.")
          }
          offset += sent
        }
        return PrintResult.Printed
      } finally {
        connection.releaseInterface(found.printer)
      }
    } catch (e: Exception) {
      return PrintResult.Failed(e.message ?: "Printing failed")
    } finally {
      connection.close()
    }
  }

  /** Android's own "Allow SnapPOS to access this printer?" dialog, and the answer to it. */
  private suspend fun askPermission(manager: UsbManager, device: UsbDevice): Boolean =
    withTimeoutOrNull(PERMISSION_WAIT_MS) {
      suspendCancellableCoroutine { continuation ->
        val action = "${context.packageName}.USB_PERMISSION"
        val receiver = object : BroadcastReceiver() {
          override fun onReceive(c: Context, intent: Intent) {
            if (intent.action != action) return
            runCatching { context.unregisterReceiver(this) }
            if (continuation.isActive) {
              continuation.resume(intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false))
            }
          }
        }
        ContextCompat.registerReceiver(context, receiver, IntentFilter(action), ContextCompat.RECEIVER_NOT_EXPORTED)
        continuation.invokeOnCancellation { runCatching { context.unregisterReceiver(receiver) } }
        // Mutable because Android writes the answer into this intent; the
        // package makes it explicit, which Android 14 insists on for that.
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
        val intent = Intent(action).setPackage(context.packageName)
        manager.requestPermission(device, PendingIntent.getBroadcast(context, 0, intent, flags))
      }
    } ?: false

  private companion object {
    /** Star Micronics' USB vendor id. The TSP143IIIU on this till is 0519:0003. */
    const val STAR_VENDOR_ID = 0x0519

    /** Well under the 64KB a USB transfer may carry, and a few hundred rows of a receipt. */
    const val CHUNK = 16 * 1024

    /** Long enough for the printer to catch up on a long receipt; short enough to notice a jam. */
    const val TIMEOUT_MS = 5_000

    /** A cashier who walked away from the dialog should not hold the next job forever. */
    const val PERMISSION_WAIT_MS = 60_000L
  }
}
