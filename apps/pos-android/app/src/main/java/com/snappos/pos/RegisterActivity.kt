package com.snappos.pos

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.snappos.pos.ui.RegisterScreen
import com.snappos.pos.ui.SnapPosTheme
import dagger.hilt.android.AndroidEntryPoint

/**
 * The register. One activity, `singleTask`, landscape.
 *
 * Single activity because a cashier must never be able to get "behind" the
 * register with the back button mid sale, and `singleTask` so that a barcode
 * scanner acting as a keyboard cannot launch a second instance with a
 * half finished cart in the first.
 */
@AndroidEntryPoint
class RegisterActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    enableEdgeToEdge()
    setContent {
      SnapPosTheme {
        RegisterScreen()
      }
    }
  }
}
