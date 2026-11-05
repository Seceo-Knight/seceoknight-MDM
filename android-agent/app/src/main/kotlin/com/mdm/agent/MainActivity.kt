package com.mdm.agent

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.mdm.agent.ui.EnrollmentScreen
import com.mdm.agent.ui.HomeScreen
import com.mdm.agent.ui.MainViewModel
import dagger.hilt.android.AndroidEntryPoint
import androidx.activity.viewModels

@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    private val vm: MainViewModel by viewModels()

    override fun onResume() {
        super.onResume()
        // Recompute enrolled state and, in a freshly-provisioned work profile,
        // finish any pending enrollment from the stash so opening the app
        // reliably connects (the first-boot worker may not have run yet).
        vm.refresh()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Surface(Modifier.fillMaxSize()) {
                    val state by vm.state.collectAsStateWithLifecycle()
                    // No admin gate: an un-elevated device can still enroll and
                    // reach the home screen ("enrolled-only" mode). Elevation
                    // guidance lives on the home screen now.
                    when (state) {
                        MainViewModel.UiState.NotEnrolled -> EnrollmentScreen(vm)
                        is MainViewModel.UiState.Enrolled -> HomeScreen(vm)
                    }
                }
            }
        }
    }
}
