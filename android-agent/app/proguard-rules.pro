# R8/ProGuard rules. We keep this short and rely on consumer rules from each
# library; only project-specific keep rules belong here.

# Keep all DPM-related receivers/services — they're referenced by manifest only.
-keep class com.mdm.core.admin.MDMDeviceAdminReceiver { *; }
-keep class com.mdm.command.CommandService { *; }

# Hilt / Dagger generated code — Hilt's own rules cover the rest but we keep
# our @HiltWorker entry points just to be safe (they're constructed reflectively).
-keep class com.mdm.enrollment.FirstBootEnroller { *; }
-keep class com.mdm.policy.PolicySyncWorker { *; }
-keep class com.mdm.telemetry.TelemetryWorker { *; }

# Moshi @JsonClass(generateAdapter = true) — the generated *_JsonAdapter classes
# are loaded by name.
-keep class com.mdm.networking.api.*JsonAdapter { *; }
-keepclassmembers class com.mdm.networking.api.** {
    <init>(...);
}

# Eclipse Paho keeps its log strings; suppress unused-resource warnings.
-dontwarn org.eclipse.paho.client.mqttv3.**

# kotlinx.serialization — runtime needs these.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class **$$serializer {
    *** descriptor;
}
