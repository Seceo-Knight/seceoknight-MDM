# Slim Android builder image for CyberSentinel MDM.
#
# Designed to fit comfortably on small dev boxes:
#   final size ~1.3 GB vs ~10 GB for community "android-build-box" images.
#
# Layout:
#   /opt/android-sdk        — Android SDK (cmdline-tools, platforms, build-tools)
#   /root/.gradle           — mounted persistent volume for Gradle caches
#   /project                — the android-agent source tree (bind mount)
FROM eclipse-temurin:17-jdk-jammy

ENV ANDROID_SDK_ROOT=/opt/android-sdk \
    ANDROID_HOME=/opt/android-sdk \
    DEBIAN_FRONTEND=noninteractive \
    GRADLE_USER_HOME=/root/.gradle

RUN apt-get update && apt-get install -y --no-install-recommends \
        bash curl unzip git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Android cmdline-tools (current channel, 11076708 ≈ 2024-09).
RUN mkdir -p $ANDROID_SDK_ROOT/cmdline-tools \
 && curl -sSL https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip \
        -o /tmp/cmdline-tools.zip \
 && unzip -q /tmp/cmdline-tools.zip -d $ANDROID_SDK_ROOT/cmdline-tools \
 && mv $ANDROID_SDK_ROOT/cmdline-tools/cmdline-tools $ANDROID_SDK_ROOT/cmdline-tools/latest \
 && rm /tmp/cmdline-tools.zip

ENV PATH=$PATH:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/platform-tools

# Accept licenses, then install only the SDK pieces our project needs.
RUN yes | sdkmanager --licenses >/dev/null \
 && sdkmanager --install \
        "platform-tools" \
        "platforms;android-34" \
        "build-tools;34.0.0" >/dev/null

WORKDIR /project
CMD ["bash"]
