package com.mdm.agent.ui

import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.Intent
import android.os.PersistableBundle
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.mdm.agent.PortraitCaptureActivity
import com.mdm.core.admin.MDMDeviceAdminReceiver
import com.mdm.enrollment.QrEnrollmentParser

@Composable
fun EnrollmentScreen(vm: MainViewModel) {
    val ctx = LocalContext.current
    var server by remember { mutableStateOf("https://mdm.example.com") }
    var token by remember { mutableStateOf("") }
    var tenant by remember { mutableStateOf("") }
    val busy by vm.busy.collectAsState()
    val error by vm.error.collectAsState()

    // Launches the managed-profile provisioning flow (BYOD work profile). After
    // the profile is created the platform fires onProfileProvisioningComplete,
    // which stashes the extras and finishes enrollment inside the profile.
    val provisionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { /* RESULT_OK just means provisioning started; enrollment continues in the profile */ }

    fun startWorkProfile(channel: String) {
        provisionLauncher.launch(workProfileIntent(ctx, server.trim(), token.trim(), tenant.trim(), channel))
    }

    // In-app QR scanner. Accepts both the agent-format JSON and the AOSP
    // Device-Owner bundle (same console QR). Auto-fills + acts on the payload.
    val scanLauncher = rememberLauncherForActivityResult(ScanContract()) { result ->
        val raw = result.contents ?: return@rememberLauncherForActivityResult
        QrEnrollmentParser.parse(raw).onSuccess { p ->
            server = p.server_url
            token = p.enrollment_token
            tenant = p.tenant_id
            if (p.provisioning_mode == "work_profile") startWorkProfile("qr_inapp")
            else vm.enroll(p.server_url, p.enrollment_token, channel = "qr_inapp")
        }.onFailure {
            // Previously a parse failure was a silent no-op (no error, no log) —
            // the screen just sat there. Surface it so a bad/unrecognized QR is
            // visible instead of looking like a hang.
            vm.reportError("Couldn't read that QR: ${it.message ?: "unrecognized format"}")
        }
    }

    Column(
        Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.Center
    ) {
        Text("SeceoKnight MDM", style = MaterialTheme.typography.headlineSmall)
        Text("SeceoKnight Technologies", style = MaterialTheme.typography.labelSmall)
        Spacer(Modifier.height(20.dp))
        Text("Device enrollment", style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(value = server, onValueChange = { server = it }, label = { Text("Server URL") })
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(value = token, onValueChange = { token = it }, label = { Text("Enrollment token") })
        Spacer(Modifier.height(16.dp))
        Button(
            onClick = { vm.enroll(server, token, channel = "direct_install") },
            enabled = !busy && token.isNotBlank()
        ) {
            if (busy) CircularProgressIndicator(strokeWidth = 2.dp)
            else Text("Enroll")
        }
        Spacer(Modifier.height(8.dp))
        OutlinedButton(
            onClick = {
                scanLauncher.launch(
                    ScanOptions()
                        .setCaptureActivity(PortraitCaptureActivity::class.java)
                        .setOrientationLocked(true)   // honour the portrait capture activity
                        .setBeepEnabled(false)
                        .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                        .setPrompt("Scan the enrollment QR")
                )
            },
            enabled = !busy,
            modifier = Modifier.fillMaxWidth()
        ) { Text("Scan QR") }
        Spacer(Modifier.height(8.dp))
        OutlinedButton(
            onClick = { startWorkProfile("direct_install") },
            enabled = !busy && token.isNotBlank(),
            modifier = Modifier.fillMaxWidth()
        ) { Text("Set up work profile") }
        error?.let {
            Spacer(Modifier.height(12.dp))
            Text(it, color = MaterialTheme.colorScheme.error)
        }
    }
}

/**
 * Builds the [DevicePolicyManager.ACTION_PROVISION_MANAGED_PROFILE] intent that
 * creates a BYOD work profile owned by this app. The server URL + token are
 * packed into the admin-extras bundle so onProfileProvisioningComplete can
 * finish enrollment inside the new profile.
 */
private fun workProfileIntent(ctx: Context, server: String, token: String, tenant: String, channel: String): Intent {
    val extras = PersistableBundle().apply {
        putString("server_url", server)
        putString("enrollment_token", token)
        putString("tenant_id", tenant)
        putString("provisioning_mode", "work_profile")
        putString("channel", channel)
    }
    return Intent(DevicePolicyManager.ACTION_PROVISION_MANAGED_PROFILE).apply {
        putExtra(
            DevicePolicyManager.EXTRA_PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME,
            MDMDeviceAdminReceiver.componentName(ctx)
        )
        putExtra(DevicePolicyManager.EXTRA_PROVISIONING_ADMIN_EXTRAS_BUNDLE, extras)
    }
}
