import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.dagger.hilt.android")
    id("com.google.devtools.ksp")
}

// Human version (versionName) read from version.properties at the repo root.
// build-apk.sh increments versionPatch on every build so each APK advances
// 1.0.0 → 1.0.1 → … The auto build number below (versionCode) still bumps too.
val verProps = Properties().apply {
    val f = rootProject.file("version.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
val agentVersionName =
    "${verProps.getProperty("versionMajor", "1")}." +
    "${verProps.getProperty("versionMinor", "0")}." +
    "${verProps.getProperty("versionPatch", "0")}"

android {
    namespace = "com.mdm.agent"
    compileSdk = Versions.compileSdk

    defaultConfig {
        applicationId = "com.mdm.agent"
        minSdk = Versions.minSdk
        targetSdk = Versions.targetSdk
        // Auto-bump: minutes since the Unix epoch. Monotonically increasing, so
        // every build is strictly newer than the last — which is exactly what an
        // OTA self-update (and `adb install -r`) needs, since Android rejects an
        // install whose versionCode isn't higher than the one already on device.
        // (Fits in Int until ~year 6000; the signing checksum is unaffected, so
        // QR/ADB Device-Owner enrollment is not impacted.) versionName stays the
        // human-readable Versions.versionName.
        versionCode = (System.currentTimeMillis() / 60_000L).toInt()
        versionName = agentVersionName
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("debug") // replace with real cert
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true; buildConfig = true }
    // No composeOptions{} needed — the org.jetbrains.kotlin.plugin.compose
    // plugin (applied above) drives the Compose compiler in Kotlin 2.0+.
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
}

dependencies {
    implementation(project(":mdm-core"))
    implementation(project(":enrollment"))
    implementation(project(":policy-engine"))
    implementation(project(":command-executor"))
    implementation(project(":telemetry"))
    implementation(project(":networking"))
    implementation(project(":camera"))
    implementation(project(":security"))

    implementation(platform(Deps.composeBom))
    implementation(Deps.composeUi)
    implementation(Deps.composeMaterial3)
    implementation(Deps.composeIcons)
    implementation(Deps.activityCompose)
    implementation(Deps.navigationCompose)
    implementation(Deps.lifecycleRuntime)
    implementation(Deps.lifecycleVMCompose)

    implementation(Deps.hiltAndroid)
    ksp(Deps.hiltCompiler)
    implementation(Deps.hiltNavCompose)
    implementation(Deps.hiltWork)
    ksp(Deps.hiltWorkCompiler)

    implementation(Deps.workmanager)
    implementation(Deps.coroutines)
    implementation(Deps.serializationJson)
    implementation(Deps.timber)
    implementation(Deps.zxingEmbedded)   // in-app QR enrollment scanner
}
