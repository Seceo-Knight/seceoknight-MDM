plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("com.google.dagger.hilt.android")
    id("com.google.devtools.ksp")
}

android {
    namespace = "com.mdm.policy"
    compileSdk = Versions.compileSdk
    defaultConfig { minSdk = Versions.minSdk }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation(project(":mdm-core"))
    implementation(project(":networking"))
    implementation(Deps.coroutines)
    implementation(Deps.serializationJson)
    implementation(Deps.timber)
    implementation(Deps.hiltAndroid)
    ksp(Deps.hiltCompiler)
    implementation(Deps.workmanager)
    implementation(Deps.hiltWork)
    ksp(Deps.hiltWorkCompiler)

    testImplementation(Deps.junit)
    testImplementation(Deps.mockk)
    testImplementation(Deps.coroutinesTest)
}
