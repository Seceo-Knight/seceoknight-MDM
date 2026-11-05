plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("com.google.dagger.hilt.android")
    id("com.google.devtools.ksp")
}

android {
    namespace = "com.mdm.core"
    compileSdk = Versions.compileSdk
    defaultConfig { minSdk = Versions.minSdk }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    api(project(":networking"))
    api(project(":security"))
    implementation(Deps.coroutines)
    implementation(Deps.serializationJson)
    // ProvisioningStash uses EncryptedSharedPreferences directly here.
    implementation(Deps.securityCrypto)
    implementation(Deps.timber)
    // Enqueue first-boot enrollment after managed-profile provisioning. We
    // reference the worker by class name (reflection) to avoid a :mdm-core →
    // :enrollment dependency cycle, so only the WorkManager runtime is needed.
    implementation(Deps.workmanager)
    implementation(Deps.hiltAndroid)
    ksp(Deps.hiltCompiler)
    testImplementation(Deps.junit)
    testImplementation(Deps.mockk)
    testImplementation(Deps.coroutinesTest)
}
