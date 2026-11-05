package com.mdm.security.di

import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent

/**
 * Placeholder Hilt module. All security classes use [@Inject constructor] so
 * Hilt's reflection-free injector picks them up automatically; this module
 * exists to anchor any future `@Provides` bindings (e.g. swapping in a
 * mock RootDetector for instrumentation runs).
 */
@Module
@InstallIn(SingletonComponent::class)
object SecurityModule
