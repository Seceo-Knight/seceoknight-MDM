// Centralized versions used by every module.
object Versions {
    const val compileSdk = 34
    const val minSdk     = 26  // Android 8.0 — covers ~95% of Enterprise fleet
    const val targetSdk  = 34
    const val versionCode = 1
    const val versionName = "1.0.0"

    const val kotlin       = "2.0.20"
    const val coroutines   = "1.9.0"
    const val serialization = "1.7.3"

    const val composeBom   = "2024.09.02"
    const val activityCompose = "1.9.2"
    const val lifecycle    = "2.8.6"
    const val navigation   = "2.8.0"

    const val hilt         = "2.51.1"
    const val hiltCompiler = "1.2.0"
    const val workmanager  = "2.9.1"
    const val coreKtx      = "1.13.1"

    const val room         = "2.6.1"
    const val retrofit     = "2.11.0"
    const val okhttp       = "4.12.0"
    const val moshi        = "1.15.1"
    const val mqtt         = "1.2.5"
    const val playServices = "21.3.0"
    const val zxingEmbedded = "4.3.0"
    const val webrtc       = "1.3.8"   // io.getstream maintained Google libwebrtc build

    const val securityCrypto = "1.1.0-alpha06"
    const val sqlcipher    = "4.5.4"

    const val timber       = "5.0.1"
    const val junit        = "4.13.2"
    const val mockk        = "1.13.12"
}

object Deps {
    const val coroutines = "org.jetbrains.kotlinx:kotlinx-coroutines-android:${Versions.coroutines}"
    const val serializationJson = "org.jetbrains.kotlinx:kotlinx-serialization-json:${Versions.serialization}"

    const val activityCompose = "androidx.activity:activity-compose:${Versions.activityCompose}"
    const val composeBom = "androidx.compose:compose-bom:${Versions.composeBom}"
    const val composeUi = "androidx.compose.ui:ui"
    const val composeMaterial3 = "androidx.compose.material3:material3"
    const val composeIcons = "androidx.compose.material:material-icons-extended"
    const val navigationCompose = "androidx.navigation:navigation-compose:${Versions.navigation}"

    const val lifecycleRuntime = "androidx.lifecycle:lifecycle-runtime-ktx:${Versions.lifecycle}"
    const val lifecycleVMCompose = "androidx.lifecycle:lifecycle-viewmodel-compose:${Versions.lifecycle}"

    const val hiltAndroid = "com.google.dagger:hilt-android:${Versions.hilt}"
    const val hiltCompiler = "com.google.dagger:hilt-android-compiler:${Versions.hilt}"
    const val hiltWork = "androidx.hilt:hilt-work:${Versions.hiltCompiler}"
    const val hiltWorkCompiler = "androidx.hilt:hilt-compiler:${Versions.hiltCompiler}"
    const val hiltNavCompose = "androidx.hilt:hilt-navigation-compose:${Versions.hiltCompiler}"

    const val workmanager = "androidx.work:work-runtime-ktx:${Versions.workmanager}"
    const val coreKtx     = "androidx.core:core-ktx:${Versions.coreKtx}"

    const val roomRuntime = "androidx.room:room-runtime:${Versions.room}"
    const val roomKtx = "androidx.room:room-ktx:${Versions.room}"
    const val roomCompiler = "androidx.room:room-compiler:${Versions.room}"

    const val retrofit = "com.squareup.retrofit2:retrofit:${Versions.retrofit}"
    const val retrofitMoshi = "com.squareup.retrofit2:converter-moshi:${Versions.retrofit}"
    const val okhttp = "com.squareup.okhttp3:okhttp:${Versions.okhttp}"
    const val okhttpLogging = "com.squareup.okhttp3:logging-interceptor:${Versions.okhttp}"
    const val moshi = "com.squareup.moshi:moshi:${Versions.moshi}"
    const val moshiKotlin = "com.squareup.moshi:moshi-kotlin:${Versions.moshi}"

    const val mqtt = "org.eclipse.paho:org.eclipse.paho.client.mqttv3:${Versions.mqtt}"

    // WebRTC for Android — Google's libwebrtc repackaged + maintained by GetStream.
    // Brings PeerConnectionFactory, ScreenCapturerAndroid (MediaProjection → video
    // track), and the SurfaceTextureHelper/encoder pipeline used for screen mirror.
    const val webrtc = "io.getstream:stream-webrtc-android:${Versions.webrtc}"

    // Google Play Services fused location — far more reliable than the raw
    // LocationManager on OEM ROMs (OnePlus/Oppo ColorOS, Xiaomi MIUI) that
    // return null last-known and never satisfy a bare GPS single-update.
    const val playServicesLocation = "com.google.android.gms:play-services-location:${Versions.playServices}"

    // In-app QR enrollment scanner. Drop-in ScanContract (camera preview +
    // permission prompt + decode) so EnrollmentScreen can scan instead of
    // typing the server URL + token. Bundles zxing-core; no CameraX needed.
    const val zxingEmbedded = "com.journeyapps:zxing-android-embedded:${Versions.zxingEmbedded}"

    const val securityCrypto = "androidx.security:security-crypto:${Versions.securityCrypto}"
    const val sqlcipher = "net.zetetic:android-database-sqlcipher:${Versions.sqlcipher}"

    const val timber = "com.jakewharton.timber:timber:${Versions.timber}"

    const val junit = "junit:junit:${Versions.junit}"
    const val mockk = "io.mockk:mockk:${Versions.mockk}"
    const val coroutinesTest = "org.jetbrains.kotlinx:kotlinx-coroutines-test:${Versions.coroutines}"
}
