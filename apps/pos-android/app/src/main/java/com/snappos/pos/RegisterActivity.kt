package com.snappos.pos

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.hilt.navigation.compose.hiltViewModel
import com.snappos.pos.ui.RegisterCustomerDisplay
import com.snappos.pos.ui.RegisterScreen
import com.snappos.pos.ui.RegisterViewModel
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
        // One view model, two screens. The customer's screen is hosted here,
        // beside the cashier's rather than inside it, so it stays up through
        // the unlock and drawer screens instead of going with them.
        val viewModel: RegisterViewModel = hiltViewModel()
        RegisterScreen(viewModel)
        RegisterCustomerDisplay(viewModel)
      }
    }
  }
}
