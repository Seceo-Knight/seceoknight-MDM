package com.mdm.agent.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.delay

/**
 * Hidden "Dev Console" — a deliberately distinct, terminal-styled full-screen
 * panel reached by the secret gesture on the Home screen (tap the Agent-version
 * line 5× then long-press). It gates on the global debug-unlock password
 * (verified offline against the cached hash) and then lets the operator repoint
 * the agent at a new server address — the dev-only escape hatch for when the
 * server's IP changes and the device would otherwise be stranded.
 */

private enum class DevStage { UNLOCK, EDITOR, DONE }

private val ACCENT = Color(0xFF35E6C0)   // cyan-green terminal accent
private val BG = Color(0xFF0A0E12)
private val MUTED = Color(0xFF6A7A82)

@Composable
fun DevConsole(vm: MainViewModel, onDismiss: () -> Unit) {
    var stage by remember { mutableStateOf(DevStage.UNLOCK) }
    var pw by remember { mutableStateOf("") }
    var denied by remember { mutableStateOf(false) }
    var url by remember { mutableStateOf(vm.currentServerUrl()) }
    var repointedHost by remember { mutableStateOf("") }
    var testing by remember { mutableStateOf(false) }
    var errorMsg by remember { mutableStateOf<String?>(null) }
    var confirmFlush by remember { mutableStateOf(false) }
    var confirmRemove by remember { mutableStateOf(false) }

    // Apply the typed URL, then VERIFY it actually works before declaring success.
    val attempt: () -> Unit = {
        if (!testing && url.isNotBlank()) {
            testing = true; errorMsg = null
            vm.applyServerConfig(url) { res ->
                testing = false
                when (res) {
                    is MainViewModel.RepointResult.Ok -> {
                        repointedHost = hostOf(url)
                        stage = DevStage.DONE
                    }
                    is MainViewModel.RepointResult.Rejected ->
                        errorMsg = "reached the server at ${res.target} but it rejected this device" +
                            (if (res.code > 0) " (HTTP ${res.code})" else "") +
                            ". it likely has a fresh database — re-enroll this device."
                    is MainViewModel.RepointResult.Unreachable ->
                        errorMsg = "could not open a connection to:\n${res.target}\n→ ${res.detail}\n" +
                            "the browser-working URL must match this exactly (scheme + port)."
                    MainViewModel.RepointResult.BadUrl ->
                        errorMsg = "that doesn't look like a valid address."
                }
            }
        }
    }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(color = BG, modifier = Modifier.fillMaxSize()) {
            AnimatedVisibility(
                visible = true,
                enter = fadeIn() + slideInVertically(initialOffsetY = { it / 8 }),
                exit = fadeOut()
            ) {
                Column(Modifier.fillMaxSize().padding(24.dp)) {
                    // ── header ───────────────────────────────────────────────
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("▌", color = ACCENT, fontFamily = FontFamily.Monospace, fontSize = 18.sp)
                        Spacer(Modifier.width(8.dp))
                        Text(
                            "CYBERSENTINEL // DEV CONSOLE",
                            color = ACCENT, fontFamily = FontFamily.Monospace,
                            fontWeight = FontWeight.Bold, fontSize = 14.sp, letterSpacing = 1.sp
                        )
                        Spacer(Modifier.weight(1f))
                        Box(Modifier.clickable { onDismiss() }.padding(8.dp)) {
                            Text("[esc]", color = MUTED, fontFamily = FontFamily.Monospace, fontSize = 13.sp)
                        }
                    }
                    Box(Modifier.fillMaxWidth().padding(top = 10.dp).height(1.dp).background(ACCENT.copy(alpha = 0.25f)))
                    Spacer(Modifier.height(28.dp))

                    when (stage) {
                        DevStage.UNLOCK -> {
                            Line("authenticate to continue", MUTED)
                            Spacer(Modifier.height(14.dp))
                            TermField(
                                value = pw,
                                onValueChange = { pw = it; denied = false },
                                placeholder = "password",
                                mask = true,
                                imeAction = ImeAction.Done,
                                onSubmit = {
                                    if (vm.verifyDebugPassword(pw)) { denied = false; stage = DevStage.EDITOR }
                                    else denied = true
                                }
                            )
                            Spacer(Modifier.height(16.dp))
                            if (denied) {
                                Text("ACCESS DENIED", color = Color(0xFFFF5C7A), fontFamily = FontFamily.Monospace, fontSize = 13.sp)
                                Spacer(Modifier.height(16.dp))
                            }
                            TermButton("> unlock", enabled = pw.isNotEmpty()) {
                                if (vm.verifyDebugPassword(pw)) { denied = false; stage = DevStage.EDITOR }
                                else denied = true
                            }
                        }

                        DevStage.EDITOR -> {
                            Line("// repoint agent → server address", ACCENT)
                            Spacer(Modifier.height(6.dp))
                            Line("we verify the new address before confirming.", MUTED)
                            Spacer(Modifier.height(18.dp))
                            Text("SERVER URL", color = MUTED, fontFamily = FontFamily.Monospace, fontSize = 11.sp, letterSpacing = 1.sp)
                            Spacer(Modifier.height(6.dp))
                            TermField(
                                value = url,
                                onValueChange = { url = it; errorMsg = null },
                                placeholder = "http://192.168.1.50:8080",
                                mask = false,
                                imeAction = ImeAction.Go,
                                onSubmit = attempt
                            )
                            Spacer(Modifier.height(16.dp))
                            if (errorMsg != null) {
                                Text("✗ ${errorMsg}", color = Color(0xFFFF5C7A), fontFamily = FontFamily.Monospace, fontSize = 13.sp)
                                Spacer(Modifier.height(16.dp))
                            }
                            TermButton(
                                label = if (testing) "> probing ${hostOf(url)}…" else "> test & reconnect",
                                enabled = url.isNotBlank() && !testing,
                                onClick = attempt
                            )

                            // Full process restart — the in-app equivalent of a
                            // device reboot, for when the in-process reconnect above
                            // can't shake a wedged connection after an address change.
                            // Keeps all credentials/config; just restarts the agent.
                            Spacer(Modifier.height(12.dp))
                            Line("restarts the agent process (keeps enrollment). like rebooting the phone.", MUTED)
                            Spacer(Modifier.height(6.dp))
                            TermButton(
                                label = "> restart app",
                                enabled = !testing,
                                onClick = { vm.restartApp() }
                            )

                            // ── danger zone ─────────────────────────────────────
                            // Hard reset: wipe ALL local state and force re-enroll.
                            // The escape hatch when the device is stuck "enrolled"
                            // with credentials the server rejects. Two-tap confirm.
                            Spacer(Modifier.height(28.dp))
                            Box(Modifier.fillMaxWidth().height(1.dp).background(Color(0xFFFF5C7A).copy(alpha = 0.25f)))
                            Spacer(Modifier.height(14.dp))
                            Text("DANGER ZONE", color = Color(0xFFFF5C7A), fontFamily = FontFamily.Monospace, fontSize = 11.sp, letterSpacing = 1.sp)
                            Spacer(Modifier.height(4.dp))
                            Line("wipes credentials + config; device must re-enroll.", MUTED)
                            Spacer(Modifier.height(10.dp))
                            DangerButton(
                                label = if (confirmFlush) "⚠ confirm: wipe everything & re-enroll" else "> fully flush",
                                enabled = !testing
                            ) {
                                if (confirmFlush) { vm.fullyFlush(); onDismiss() } else confirmFlush = true
                            }

                            // Remove agent: notify the server (if reachable), drop
                            // Device Owner/Admin so the package is uninstallable,
                            // then launch the uninstaller (or self-wipe the work
                            // profile in BYOD). Two-tap confirm.
                            Spacer(Modifier.height(14.dp))
                            Line("notifies server, drops admin, then uninstalls the agent.", MUTED)
                            Spacer(Modifier.height(10.dp))
                            DangerButton(
                                label = if (confirmRemove) "⚠ confirm: remove & uninstall agent" else "> remove agent",
                                enabled = !testing
                            ) {
                                if (confirmRemove) { vm.removeAgent(); onDismiss() } else confirmRemove = true
                            }
                        }

                        DevStage.DONE -> {
                            Text("✓ CONNECTED", color = ACCENT, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, fontSize = 16.sp)
                            Spacer(Modifier.height(10.dp))
                            Line("→ $repointedHost", MUTED)
                            Spacer(Modifier.height(8.dp))
                            Line("the server now sees this device online.", MUTED)
                            LaunchedEffect(Unit) { delay(1500); onDismiss() }
                        }
                    }
                }
            }
        }
    }
}

/** Effective `host:port` for a typed URL — defaults a missing scheme to http://
 *  and makes the EFFECTIVE port explicit (http→80, https→443) so the panel can
 *  show exactly where it's connecting. A wrong/implicit port (the usual repoint
 *  gotcha: omitting :8080) is then visible at a glance instead of hidden. */
private fun hostOf(raw: String): String {
    var s = raw.trim().trimEnd('/')
    if (s.isBlank()) return raw
    if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://$s"
    val uri = android.net.Uri.parse(s)
    val host = uri.host ?: return raw
    val port = if (uri.port > 0) uri.port else if (s.startsWith("https://")) 443 else 80
    return "$host:$port"
}

@Composable
private fun Line(text: String, color: Color) {
    Text(text, color = color, fontFamily = FontFamily.Monospace, fontSize = 13.sp)
}

@Composable
private fun TermField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    mask: Boolean,
    imeAction: ImeAction,
    onSubmit: () -> Unit
) {
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        singleLine = true,
        textStyle = TextStyle(color = ACCENT, fontFamily = FontFamily.Monospace, fontSize = 16.sp),
        cursorBrush = SolidColor(ACCENT),
        visualTransformation = if (mask) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
        keyboardOptions = KeyboardOptions(
            keyboardType = if (mask) KeyboardType.Password else KeyboardType.Uri,
            imeAction = imeAction
        ),
        keyboardActions = KeyboardActions(onDone = { onSubmit() }, onGo = { onSubmit() }),
        modifier = Modifier.fillMaxWidth(),
        decorationBox = { inner ->
            Row(
                Modifier.fillMaxWidth()
                    .border(1.dp, ACCENT.copy(alpha = 0.4f), RoundedCornerShape(8.dp))
                    .background(Color(0xFF0E141A), RoundedCornerShape(8.dp))
                    .padding(horizontal = 14.dp, vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text("> ", color = ACCENT, fontFamily = FontFamily.Monospace, fontSize = 16.sp)
                Box(Modifier.weight(1f)) {
                    if (value.isEmpty()) {
                        Text(placeholder, color = ACCENT.copy(alpha = 0.30f), fontFamily = FontFamily.Monospace, fontSize = 16.sp)
                    }
                    inner()
                }
            }
        }
    )
}

@Composable
private fun TermButton(label: String, enabled: Boolean, onClick: () -> Unit) {
    val tint = if (enabled) ACCENT else MUTED
    Box(
        Modifier
            .border(1.dp, tint.copy(alpha = 0.6f), RoundedCornerShape(8.dp))
            .background(tint.copy(alpha = 0.08f), RoundedCornerShape(8.dp))
            .clickable(enabled = enabled) { onClick() }
            .padding(horizontal = 18.dp, vertical = 12.dp)
    ) {
        Text(label, color = tint, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, fontSize = 14.sp)
    }
}

private val DANGER = Color(0xFFFF5C7A)

@Composable
private fun DangerButton(label: String, enabled: Boolean, onClick: () -> Unit) {
    val tint = if (enabled) DANGER else MUTED
    Box(
        Modifier
            .border(1.dp, tint.copy(alpha = 0.7f), RoundedCornerShape(8.dp))
            .background(tint.copy(alpha = 0.10f), RoundedCornerShape(8.dp))
            .clickable(enabled = enabled) { onClick() }
            .padding(horizontal = 18.dp, vertical = 12.dp)
    ) {
        Text(label, color = tint, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, fontSize = 14.sp)
    }
}
