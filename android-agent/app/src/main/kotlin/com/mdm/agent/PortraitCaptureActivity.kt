package com.mdm.agent

import com.journeyapps.barcodescanner.CaptureActivity

/**
 * zxing-android-embedded's default CaptureActivity follows the sensor and tends
 * to open in landscape. This subclass exists only so the manifest can pin the
 * scanner to portrait (android:screenOrientation="portrait"). Referenced via
 * ScanOptions.setCaptureActivity in EnrollmentScreen.
 */
class PortraitCaptureActivity : CaptureActivity()
