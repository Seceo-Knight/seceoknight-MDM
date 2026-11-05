package com.mdm.command

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Pins the wire ↔ enum mapping. Any new server-side kind must round-trip
 * through this test before being added to [CommandExecutor]'s dispatch.
 */
class CommandKindTest {

    @Test
    fun `every enum round trips through wire`() {
        CommandKind.values().forEach {
            assertEquals(it, CommandKind.fromWire(it.wire))
            assertEquals(it, CommandKind.fromWire(it.wire.lowercase()))
        }
    }

    @Test
    fun `unknown wire returns null`() {
        assertNull(CommandKind.fromWire("DESTROY_EARTH"))
    }
}
