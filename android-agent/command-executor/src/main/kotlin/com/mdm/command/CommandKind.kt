package com.mdm.command

/**
 * Mirrors /server/command-service/internal/types/commands.go. Server uses
 * snake_case wire strings; we keep an enum-friendly mapping here.
 */
enum class CommandKind(val wire: String) {
    LOCK("LOCK"),
    WIPE("WIPE"),
    REMOVE_WORK_PROFILE("REMOVE_WORK_PROFILE"),  // Profile Owner: wipe only the work profile
    REBOOT("REBOOT"),
    SYNC_POLICY("SYNC_POLICY"),
    APPLY_POLICY("APPLY_POLICY"),          // alias of SYNC_POLICY; admin UI uses this name
    CLEAR_POLICY("CLEAR_POLICY"),          // unassign-and-reset: revert all enforced settings to default
    INSTALL_APP("INSTALL_APP"),
    UNINSTALL_APP("UNINSTALL_APP"),
    HIDE_APP("HIDE_APP"),
    SHOW_APP("SHOW_APP"),
    BLOCK_UNINSTALL("BLOCK_UNINSTALL"),
    ALLOW_UNINSTALL("ALLOW_UNINSTALL"),
    INSTALL_CERT("INSTALL_CERT"),
    REMOVE_CERT("REMOVE_CERT"),
    SET_VPN("SET_VPN"),
    SET_PROXY("SET_PROXY"),
    SET_RESTRICTION("SET_RESTRICTION"),
    SET_PASSWORD_POLICY("SET_PASSWORD_POLICY"),
    SET_SYSTEM_UPDATE("SET_SYSTEM_UPDATE"),
    PUSH_TELEMETRY("PUSH_TELEMETRY"),
    PING("PING"),
    CLEAR_PASSWORD("CLEAR_PASSWORD"),
    RESET_PASSWORD("RESET_PASSWORD"),
    LOG_OFF_USER("LOG_OFF_USER"),
    FETCH_DEVICE_INFO("FETCH_DEVICE_INFO"),
    FETCH_APP_INVENTORY("FETCH_APP_INVENTORY"),
    FETCH_APP_USAGE("FETCH_APP_USAGE"),    // time-in-app (UsageStatsManager), per-profile scoped
    COLLECT_LOGS("COLLECT_LOGS"),
    CLEAR_APP_DATA("CLEAR_APP_DATA"),
    CAPTURE_PHOTO("CAPTURE_PHOTO"),
    START_AUDIO_STREAM("START_AUDIO_STREAM"),
    STOP_AUDIO_STREAM("STOP_AUDIO_STREAM"),
    START_SCREEN_SHARE("START_SCREEN_SHARE"),  // live screen mirror (WebRTC), Device Owner only
    STOP_SCREEN_SHARE("STOP_SCREEN_SHARE"),
    WAKE_DEVICE("WAKE_DEVICE"),                 // remote power-button: turn the screen on, Device Owner only
    SET_FLASHLIGHT("SET_FLASHLIGHT"),
    PLAY_SOUND("PLAY_SOUND"),
    GET_LOCATION("GET_LOCATION"),
    SHOW_MESSAGE("SHOW_MESSAGE");

    companion object {
        private val byWire = values().associateBy { it.wire }
        fun fromWire(s: String): CommandKind? = byWire[s.uppercase()]
    }
}
