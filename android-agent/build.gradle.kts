// Root build script. All module-level configuration lives in each module's
// build.gradle.kts; this file only declares the plugins they apply.
plugins {
    id("com.android.application")    version "8.5.2" apply false
    id("com.android.library")        version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "2.0.20" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.0.20" apply false
    // Kotlin 2.0 split the Compose Compiler out of the Kotlin plugin; it
    // ships as its own plugin from the same version stream now.
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.20" apply false
    id("com.google.dagger.hilt.android") version "2.51.1" apply false
    id("com.google.devtools.ksp")    version "2.0.20-1.0.25" apply false
}
