plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("com.google.dagger.hilt.android")
    id("com.google.devtools.ksp")
}

android {
    namespace = "com.mdm.networking"
    compileSdk = Versions.compileSdk
    defaultConfig {
        minSdk = Versions.minSdk
        buildConfigField("String", "DEFAULT_SERVER_URL", "\"https://mdm.example.com\"")
    }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    api(project(":security"))

    api(Deps.retrofit)
    api(Deps.retrofitMoshi)
    api(Deps.okhttp)
    implementation(Deps.okhttpLogging)
    api(Deps.moshi)
    implementation(Deps.moshiKotlin)
    api(Deps.mqtt)

    implementation(Deps.coroutines)
    implementation(Deps.serializationJson)
    implementation(Deps.timber)
    implementation(Deps.securityCrypto)
    implementation(Deps.hiltAndroid)
    ksp(Deps.hiltCompiler)

    testImplementation(Deps.junit)
    testImplementation(Deps.mockk)
    testImplementation(Deps.coroutinesTest)
}
