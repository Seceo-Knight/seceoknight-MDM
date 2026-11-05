package com.mdm.security

import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * Smoke test: on a CI runner without su, all heuristics should be negative.
 * Anything that flips here means a heuristic has a false positive that needs
 * looking at before shipping.
 */
class RootDetectorTest {

    @Test
    fun `clean environment reports unrooted`() {
        // /system is read-only on CI, no su binary, no Magisk markers.
        val detector = RootDetector()
        assertFalse("clean env should not be rooted", detector.isRooted())
    }
}
