plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("com.google.dagger.hilt.android")
    id("com.google.devtools.ksp")
}

android {
    namespace = "com.mdm.security"
    compileSdk = Versions.compileSdk
    defaultConfig { minSdk = Versions.minSdk }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation(Deps.coroutines)
    implementation(Deps.timber)
    implementation(Deps.coreKtx)
    implementation(Deps.securityCrypto)
    implementation(Deps.hiltAndroid)
    ksp(Deps.hiltCompiler)
    testImplementation(Deps.junit)
    testImplementation(Deps.mockk)
}
