package com.mdm.camera

import android.content.Context
import android.media.AudioManager
import android.media.RingtoneManager
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import timber.log.Timber
import javax.inject.Inject
import javax.inject.Singleton

/**
 * "Find device" buzzer: plays the alarm ringtone at full volume for a bounded
 * duration and vibrates in tandem. We intentionally bypass DND for asset
 * recovery — this is gated server-side by an admin permission.
 */
@Singleton
class Buzzer @Inject constructor(
    @ApplicationContext private val context: Context
) {

    fun ringFor(durationMs: Long = 10_000L) {
        val am = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
        val ringtoneUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
        val ringtone = RingtoneManager.getRingtone(context, ringtoneUri)

        val prevVol = am?.getStreamVolume(AudioManager.STREAM_ALARM) ?: 0
        val maxVol = am?.getStreamMaxVolume(AudioManager.STREAM_ALARM) ?: 0
        runCatching { am?.setStreamVolume(AudioManager.STREAM_ALARM, maxVol, 0) }

        runCatching { ringtone.play() }
        val vibrator = vibrator()
        runCatching {
            vibrator?.vibrate(
                VibrationEffect.createWaveform(longArrayOf(0, 800, 200, 800, 200), 0)
            )
        }

        CoroutineScope(Dispatchers.IO).launch {
            delay(durationMs)
            runCatching { ringtone.stop() }
            runCatching { vibrator?.cancel() }
            runCatching { am?.setStreamVolume(AudioManager.STREAM_ALARM, prevVol, 0) }
            Timber.i("Buzzer stopped")
        }
    }

    private fun vibrator(): Vibrator? {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)
                ?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
    }
}
