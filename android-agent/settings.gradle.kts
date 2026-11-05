pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "mdm-agent"

include(":app")
include(":mdm-core")
include(":enrollment")
include(":telemetry")
include(":policy-engine")
include(":command-executor")
include(":networking")
include(":security")
include(":camera")
